/*
// This konnector retrieves invoices from EDF
// creation : 12/06/2016
// creator : https://github.com/SomeAverageDev
*/
'use strict';

const request = require('request').defaults({
  jar: true,
  rejectUnauthorized: false,
  followAllRedirects: true,
  headers: {
    'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3',
    'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:47.0) Gecko/20100101 Firefox/47.0',
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
  prefix: 'EDF',
  date: true,
});

const fileOptions = {
  vendor: 'EDF',
  dateFormat: 'YYYYMMDD',
};

const Bill = require('../models/bill');
const baseUrl = 'https://particulier.edf.fr';

// Konnector
const connector = module.exports = baseKonnector.createNew({
  name: 'EDF',
  vendorLink: baseUrl,
  fields: {
    login: 'text',
    password: 'password',
    folderPath: 'folder',
  },
  models: [Bill],
  fetchOperations: [
    logIn,
    fetchBillingInfo,
    parsePage,
    customFilterExisting,
    customSaveDataAndFile,
    linkBankOperation({
      log,
      model: Bill,
      identifier: 'EDF',
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
  if (requiredFields.password.length === 0 || requiredFields.login.length === 0) {
    return next('bad credentials');
  }

  data.inputs = {
    login: requiredFields.login,
    password: requiredFields.password,
    rememberMe: 'false',
    goto: '',
  };

  const options = {
    method: 'POST',
    url: `${baseUrl}/bin/edf_rc/servlets/authentication`,
    form: data.inputs,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://particulier.edf.fr/fr/accueil/facture-et-contrat/facture/consulter-et-payer-ma-facture/login.html?origine=page_mes_factures&service=page_mes_factures',
    },
  };

  connector.logger.info('Logging in on EDF website...');

  request(options, (err, res, body) => {
    if (err) return next(err);

    const response = JSON.parse(body);
    log.debug(response);

    if (response.errorLabel.match(/Authentication OK/) === null) {
      return next('bad credentials');
    }
    if (response.urlRedirect.length > 0) {
      data.nextUrl = response.urlRedirect;
    } else {
      data.nextUrl = 'https://particulier.edf.fr/bin/edf_rc/servlets/edfSasServlet?service=page_mes_factures';
    }

    return true;
  });
  return next();
}

function fetchBillingInfo(requiredFields, bills, data, next) {
  const url = 'https://particulier.edf.fr/bin/edf_rc/servlets/edfSasServlet?service=page_mes_factures';

  connector.logger.info('Fetch bill info');
  const options = {
    method: 'GET',
    url,
    headers: {
      Referer: `${baseUrl}/fr/accueil/espace-client/tableau-de-bord.html`,
    },
  };

  request(options, (err, res, body) => {
    if (err) {
      log.error('An error occured while fetching bills');
      log.raw(err);
      return next(err);
    }
    connector.logger.info('Fetch bill info succeeded');

    data.html = body;
    log.debug(body);

    return next();
  });
}

function parsePage(requiredFields, bills, data, next) {
  bills.fetched = [];
  moment.locale('fr');

  return next();

  const $ = cheerio.load(data.html);

  const obj = $('div.factures').html();
  log.debug(obj);


  $('div.factures').each(function a() {
    const $tds = $(this).find('td');
    console.log($tds.eq(0).text().trim());
/*
    const billReference = $tds.eq(0).text().trim();
    let billDate = $tds.eq(1).text().trim();
    let billAmount = $tds.eq(2).text().trim();
    const billUrl = $tds.eq(3).html();

    if (billUrl && billReference && billDate && billAmount) {
      try {
        billAmount = parseFloat(((billAmount.match(/(\d+,\d+)/))[0])
                                            .replace(',', '.')
                                );

        const month = parseInt((
          billUrl.trim()
                 .match(/processus=facture_(\d+)_\d+/))[1], 10) - 1;

        billDate = billDate.split(' ');

        // invoices have no emitted day, so 28 of every month might fit
        const bill = {
          date: moment([billDate[1], month, 28]),
          type: 'energy',
          amount: billAmount,
          pdfurl: `${baseUrl}/ASPFront/com/edf/asp/portlets/generationpdf/getFacturePDF.do?numFact=`,
          vendor: 'EDF',
        };

        // saving bill
        bills.fetched.push(bill);
      } catch (e) {
        log.error('parsePage:', e);
        log.raw(e);
        return next(e);
      }
    }
*/
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
  const fnsave = saveDataAndFile(log, Bill, fileOptions, ['edf', 'energie']);
  fnsave(requiredFields, bills, data, next);
  return next();
}

function buildNotifContent(requiredFields, bills, data, next) {
  if (bills.filtered.length > 0) {
    const localizationKey = 'notification edf';
    const options = {
      smart_count: bills.filtered.length,
    };
    bills.notifContent = localization.t(localizationKey, options);
  }

  return next();
}

function logOut(requiredFields, bills, data, next) {
  const url = 'https://particulier.edf.fr/content/EDF_RC/fr/accueil/connexion/deconnexion/aeldeconnexion.html';
  const options = {
    method: 'GET',
    url,
  };

  connector.logger.info('Logout');

  request(options, (err) => {
    if (err) {
      log.error(err);
      return next(err);
    }
    return true;
  });
  return next();
}
