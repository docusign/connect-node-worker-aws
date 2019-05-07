/**
 * @file
 * processNotification -- Handle an event notification
 * 
 * Strategy for this worker example:
 * 1. Notifications are ignored unless the notification's envelope:
 *    a. Envelope status is completed
 *    b. The envelope has an Envelope Custom Field "Sales order" with content
 * 2. The software will then download and store the "combined" document on the
 *    configured "outputDir" directory. The format will be "Order_xyz.pdf"
 *    where xyz is the value from the "Sales order" Envelope Custom Field.
 * 
 *    The combined document download will include the certificate of completion
 *    if the Admin Tool is set: screen Signing Settings, section Envelope Delivery
 *       option Attach certificate of completion to envelope is checked.
 * 
 * To manually test: curl -X POST localhost:5000/docusign-listener?test=123
 * To manually test a broken worker: curl -X POST localhost:5000/docusign-listener?test=/break
 * 
 * @author DocuSign
 * 
 */

const dsConfig = require('../ds_configuration.js').config
    , parseString = require('xml2js').parseString
    , {promisify} = require('util')
    , fse = require('fs-extra')
    , path = require('path')
    , dsJwtAuth = require('./dsJwtAuth')
    , docusign = require('docusign-esign')
    , parseStringAsync = promisify(parseString)
    , testOutputDirName = dsConfig.testOutputDirName
    , testOutputDir = path.join(path.normalize("./tests"), testOutputDirName)
    , outputDir = path.join(process.cwd(), dsConfig.outputDir)
    , sleep = (seconds) => {
        return new Promise(resolve => setTimeout(resolve, 1000 * seconds))}
    ;

const processNotification = exports;

/**
 * Process the notification message
 * @param {boolean||string} test null or false indicates: real data, not a test.
 *                       Other values are used as the test data value.
 *                       If a test value includes /break then the worker will immediately exit.
 *                       This is for testing job recovery when the worker crashes. 
 * @param {string} xml if !test 
 */
processNotification.process = async (test, xml) => {
    if (test) {
        return await processTest(test);
    }

    // Step 1. parse the xml
    const msg = await parseStringAsync(xml)
        , envelopeStatus = msg.DocuSignEnvelopeInformation.EnvelopeStatus[0]
        , envelopeId = envelopeStatus.EnvelopeID[0]
        , created = envelopeStatus.Created[0] // date/time the envelope was created
        , status = envelopeStatus.Status[0]
        , completed = status == 'Completed' ? envelopeStatus.Completed[0] : false  // when env was completed
        , subject = envelopeStatus.Subject[0]
        , senderName = envelopeStatus.UserName[0]
        , senderEmail = envelopeStatus.Email[0]
        , completedMsg = completed ? `Completed ${completed}.` : ""
        , orderNumber = getOrderNumber(envelopeStatus)
        ;
    
    // For debugging, you can print the entire notification
    //console.log(`received notification!\n${JSON.stringify(msg, null, "    ")}`);

    console.log (`${new Date().toUTCString()} EnvelopeId ${envelopeId} Status: ${status}.
    Order number: ${orderNumber}. Subject: ${subject}
    Sender: ${senderName} <${senderEmail}>. Sent ${created}. ${completedMsg}`);

    // Step 2. Filter the notifications
    // Connect sends notifications about all envelopes from the account, sent by anyone.
    // So in many use cases, we will need to filter out some notifications.
    // Notifications that we don't want should be simply ignored. 
    // DO NOT reject them by sending a 400 response to DocuSign--that would only
    // cause them to be resent.
    //
    // For this example, we'll filter out any notifications unless the 
    // envelope status is complete and has an "Order number" envelope custom field
    if (status != "Completed") {
        if (dsConfig.debug) {console.log(`IGNORED: envelope status is ${status}.`)}
        return
    }
    if (!orderNumber) {
        if (dsConfig.debug) {console.log(`IGNORED: envelope does not have a  ${dsConfig.envelopeCustomField} envelope custom field.`)}
        return
    }
    
    // Step 3. Check that this is not a duplicate notification
    // The queuing system delivers on an "at least once" basis. So there is a 
    // chance that we have already processes this notification.
    //
    // For this example, we'll just repeat the document fetch if it is duplicate notification
    
    // Step 3 Download and save the "combined" document
    try {
        await saveDoc(envelopeId, orderNumber)
    } catch (e) {
        // Returning a promise rejection tells the queuing system that the 
        // failied. It will be retried by the queuing system.
        return Promise.reject(new Error("job process#saveDoc error"))
    } 
}

/**
 * Search through the Envelope Custom Fields to see if an order number
 * field is present
 * @param {object} envelopeStatus 
 */
function getOrderNumber(envelopeStatus){
    const customFields = envelopeStatus.CustomFields[0].CustomField
        , orderField = customFields.find( field => field.Name[0] == dsConfig.envelopeCustomField)
        , result = orderField ? orderField.Value[0] : null;
    return result
}

/**
 * Downloads and saves the combined documents from the envelope.
 * 
 * @param {string} envelopeId 
 * @param {string} orderNumber
 */
async function saveDoc(envelopeId, orderNumber) {
    try {
        await dsJwtAuth.checkToken();
        let dsApiClient = new docusign.ApiClient();
        dsApiClient.setBasePath(dsJwtAuth.basePath);
        dsApiClient.addDefaultHeader('Authorization', 'Bearer ' + dsJwtAuth.accessToken);
        let envelopesApi = new docusign.EnvelopesApi(dsApiClient);
    
        // Call EnvelopeDocuments::get.
        const docResult = await envelopesApi.getDocument(
                dsJwtAuth.accountId, envelopeId, "combined", null)
            , sanitizedOrderNumber = orderNumber.replace(/\W/g, '_')
            , fileName = dsConfig.outputFilePefix + sanitizedOrderNumber + '.pdf';
        
        // create the output dir if need be
        const dirExists = await fse.exists(outputDir);
        if (!dirExists) {await fse.mkdir(outputDir)}

        // Create the output file
        await fse.writeFile(path.join(outputDir, fileName), docResult, 'binary');

        if (dsConfig.enableBreakTest && ("" + orderNumber).includes("/break")) {
            throw new Error('Break test')
        }

    } catch (e) {
        console.error(`\n${new Date().toUTCString()} Error while fetching and saving docs for envelope ${envelopeId}, order ${orderNumber}.`);
        console.error(e);
        throw new Error("saveDoc error");
    }
}

/**
 * 
 * @param {string} test -- what value was sent as a test.
 * It will be stored in one of testOutputDir/test1.txt, test2.txt, test3.txt, test4.txt, test5.txt
 * 
 * If a test value includes /break then the worker will immediately exit.
 * This is for testing job recovery when the worker crashes. 
 *
 */
async function processTest (test) {
    // Are we being asked to crash?
    if (dsConfig.enableBreakTest && ("" + test).includes("/break")) {
        console.error(`${new Date().toUTCString()} BREAKING worker test!`);
        process.exit(2);
    }

    console.log(`Processing test value ${test}`);

    // Create testOutputDir if need be
    const dirExists = await fse.exists(testOutputDir);
    if (!dirExists) {
        await fse.mkdir(testOutputDir)
    }

    // The new test message will be placed in test1.
    // So first shuffle test4 to test5 (if it exists); and so on.
    for (const i of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
        const oldFile = `test${i}.txt`
            , newFile = `test${i + 1}.txt`
            , oldExists = await fse.exists(path.join(testOutputDir, oldFile))
            ;
        if (oldExists) {
            await fse.rename (path.join(testOutputDir, oldFile), path.join(testOutputDir, newFile))
        }
    }

    // Now write the test message into test1.txt
    await fse.writeFile(path.join(testOutputDir, "test1.txt"), test);
}