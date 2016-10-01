/*
// This konnector retrieves invoices from http://www.leclercdrive.fr
// creation : 13/06/2016
// creator : https://github.com/SomeAverageDev
*/
'use strict';

const request = require('request').defaults({
  jar: true,
  rejectUnauthorized: false,
  followAllRedirects: true,
  headers: {
    'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3',
    'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:47.0)' +
      'Gecko/20100101 Firefox/47.0',
  },
});

const moment = require('moment');
const cheerio = require('cheerio');
const baseKonnector = require('../lib/base_konnector');

const filterExisting = require('../lib/filter_existing');
const localization = require('../lib/localization_manager');
const saveDataAndFile = require('../lib/save_data_and_file');
const linkBankOperation = require('../lib/link_bank_operation');

const log = require('printit')({
  prefix: 'leclercdrive',
  date: true,
});

const fileOptions = {
  vendor: 'leclercdrive',
  dateFormat: 'YYYYMMDD',
};

const Bill = require('../models/bill');
const baseUrl = 'http://www.leclercdrive.fr';

// Konnector
const connector = module.exports = baseKonnector.createNew({
  name: 'leclercdrive',
  vendorLink: baseUrl,
  fields: {
    login: 'text',
    password: 'password',
    folderPath: 'folder',
  },
  models: [Bill],
  fetchOperations: [
    logIn,
    fetchBillingUrl,
    fetchBillingPage,
    parsePage,
    customFilterExisting,
    customSaveDataAndFile,
    linkBankOperation({
      log,
      model: Bill,
      identifier: 'E.LECLERC',
      minDateDelta: 4,
      maxDateDelta: 20,
      amountDelta: 0.1,
    }),
    buildNotifContent,
    logOut,
  ],
});


// Procedure to login
function logIn(requiredFields, bills, data, next) {
  const options = {
    method: 'GET',
    url: 'https://fd7-secure.leclercdrive.fr/secure/connecter.ashz?' +
      'callbackJsonp=jQuery14568186469871705348_145632674700&' +
      `d={"sLogin":"${requiredFields.login}",` +
      `"sMotDePasse":"${requiredFields.password}","fResterConnecte":false}`,
    headers: {
      Referer: baseUrl,
    },
  };

  if (requiredFields.login.length === 0
      || requiredFields.password.length === 0) {
    next('bad credentials');
  } else {
    connector.logger.info('Logging in on leclercdrive website...');


    request(options, (err, res, body) => {
      log.debug('res.statusCode:', res.statusCode);

      try {
        let response = JSON.parse((body.match(/({.*})/))[1]);

        if (response.objDonneesReponse) {
          response = response.objDonneesReponse;
          log.debug(JSON.stringify(response, null, 4));

          if (response.hasOwnProperty('sURLCourses')
            && response.hasOwnProperty('iIdClient')) {
            data.nextUrl = response.sURLCourses;
            log.debug('data.nextUrl:', data.nextUrl);
          } else {
            log.debug(JSON.stringify(response, null, 4));
            return next('bad credentials');
          }
        }
      } catch (e) {
        log.error('parsing error:', e);
        return next('bad credentials');
      }

      connector.logger.info('Successfully logged in.');
      return next();
    });
  }
  return true;
}

function fetchBillingUrl(requiredFields, bills, data, next) {
  connector.logger.info('Fetch bill URL');
  log.debug('data:', data);
  const options = {
    method: 'GET',
    url: data.nextUrl,
  };
  log.debug('options:', options);

  request(options, (err, res, body) => {
    if (err) {
      log.error('An error occured while fetching bills');
      log.raw(err);
      return next(err);
    }

    const $ = cheerio.load(body);
    data.nextUrl = $('#ctl00_MasterHeader_AccesMonCompte_divWCLD306_' +
      'ConnexionAuthentifie .divWCLD306_ConnexionBox ul.liste li')
      .eq(4)
      .children('a')
      .attr('href');

    log.debug('data.nextUrl:', data.nextUrl);

    return next();
  });
  return true;
}

function fetchBillingPage(requiredFields, bills, data, next) {
  connector.logger.info('Fetch bill page');

  const options = {
    method: 'GET',
    url: data.nextUrl,
  };

  log.debug('options:', options);

  request(options, (err, res, body) => {
    if (err) {
      log.error('An error occured while fetching bill page');
      log.raw(err);
      return next(err);
    }
    connector.logger.info('Fetch bill page succeeded');

    data.html = body;

    return next();
  });
  return true;
}

function parsePage(requiredFields, bills, data, next) {
  connector.logger.info('parsing bill page');
  bills.fetched = [];
  moment.locale('fr');
  const $ = cheerio.load(data.html);

  $('table[id=historique] tr').each(function a(trIndex) {
    if (trIndex > 0) {
      const $tds = $(this).find('td');

      // parsing date
      const billDate = $tds.eq(1)
        .find('span#ctl00_main_ascWCCD010_Historique' +
          'Commandes_lvHistCom_ctrl0_lblCommandeInfo')
        .text()
        .split(' ');

      // parsing amount
      let billAmount = $tds.eq(4)
        .children('strong')
        .text()
        .trim();

      try {
        billAmount = parseFloat(((billAmount.match(/(\d+\.\d+)/))[0]));
      } catch (e) {
        log.error('billAmount parseFloat:', e);
        log.raw(e);
        return next(e);
      }

      // parsing pdf url
      let billUrl = $tds.eq(5)
        .find('option')
        .eq(2)
        .attr('data-param')
        .trim();

      billUrl = billUrl.replace('rapport/', '');
      billUrl = billUrl.replace('bon-de-commande', 'bondecommande');

      log.debug('billAmount:', billAmount);
      log.debug('billUrl:', billUrl);
      log.debug('billDate:', billDate);

      const bill = {
        date: moment(billDate[0], 'DD-MM-YYYY'),
        type: 'shop',
        amount: billAmount,
        pdfurl: billUrl,
        vendor: 'leclercdrive',
      };

      // saving bill
      bills.fetched.push(bill);
    }
    return true;
  });

  connector.logger.info('Successfully parsed the page, bills found:',
    bills.fetched.length);

  return next();
}

function customFilterExisting(requiredFields, bills, data, next) {
  filterExisting(log, Bill)(requiredFields, bills, data, next);
  return next();
}

function customSaveDataAndFile(requiredFields, bills, data, next) {
  const fnsave = saveDataAndFile(
    log, Bill, fileOptions, ['leclercdrive', 'facture']
  );
  fnsave(requiredFields, bills, data, next);
  return next();
}

function buildNotifContent(requiredFields, bills, data, next) {
  if (bills.filtered.length > 0) {
    const localizationKey = 'notification leclercdrive';
    const options = {
      smart_count: bills.filtered.length,
    };
    bills.notifContent = localization.t(localizationKey, options);
  }
  return next();
}

function logOut(requiredFields, bills, data, next) {
  const url = 'http://fd7-courses.leclercdrive.fr/deconnecter.ashz?' +
    'callbackJsonp=jQuery183032397447916930866_1465842712776&d=undefined';
  const options = {
    method: 'GET',
    url,
  };

  request(options, (err) => {
    if (err) {
      log.error(err);
      return next(err);
    }
    return next();
  });

  connector.logger.info('Successfully logout');
  return true;
}
