#!/usr/bin/env node

/**
 * See settings in ds_configuration.js
 */

const dsConfig = require('./ds_configuration.js').config
    , AWS = require('aws-sdk')
    , processNotification = require('./lib/processNotification.js')
    , dsJwtAuth = require('./lib/dsJwtAuth')
    , queueUrl = dsConfig.queueUrl
    , queueRegion = dsConfig.queueRegion
    ;

const sleep = (seconds) => {
      return new Promise(resolve => setTimeout(resolve, 1000 * seconds))
}

/**
 * Process a message
 * See https://github.com/Azure/azure-sdk-for-js/tree/master/sdk/servicebus/service-bus#register-message-handler
 * @param {string} message
 */
const messageHandler = async function _messageHandler (message, queue) {
  if (dsConfig.debug) {
    let m = `Processing message id ${message.MessageId}`;
    console.log(`${new Date().toUTCString()} ${m}`);
  }

  let body;
  try {body = JSON.parse(message.Body)} catch(e) {body = false}

  if (body) {
    await processNotification.process(body.test, body.xml);
  } else {
    let m = `Null or bad body in message id ${message.messageId}. Ignoring.`;
    console.log(`${new Date().toUTCString()} ${m}`);
  }
  await queue.deleteMessage({QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle}).promise();
}

/**
 * The function will listen forever, dispatching incoming notifications
 * to the processNotification library. 
 * See https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/sqs-examples-send-receive-messages.html#sqs-examples-send-receive-messages-receiving
 */
async function listenForever() {
  // Check that we can get a DocuSign token
  await testToken();

  let queue = null
    , restart = true
    ;

  const startQueue = async () => {
    let checkLogQ = []; // Last four queue checking log messages.

    /**
     * Maintain the array checkLogQ as a FIFO buffer with length 4.
     * When a new entry is added, remove oldest entry and shuffle.
     * @param {string} msg 
     */
    function addCheckLogQ(msg) {
      const len = 4;
      if (checkLogQ.length < len) {checkLogQ.push(msg)}
      else {
        for (let i = 0; i < len - 1; i++) {
          checkLogQ[i] = checkLogQ [i+1]
        }
        checkLogQ[len - 1] = msg;
      }
    }
    /**
     * Dump checkLogQ to the console
     */
    function printCheckLogQ() {
      checkLogQ.forEach(m =>{console.log(m)});
      checkLogQ = []; // reset
    }


    try {
      AWS.config.update({region: queueRegion});
      queue = new AWS.SQS({apiVersion: '2012-11-05'});
      const params = {
        MaxNumberOfMessages: 10,
        MessageAttributeNames: ["All"],
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20
       };

      while (true) {
        addCheckLogQ(`${new Date().toUTCString()} Awaiting a message...`);
        let data = await queue.receiveMessage(params).promise()
        let msgCount = data.Messages ? data.Messages.length : 0;
        addCheckLogQ(`${new Date().toUTCString()} Found ${msgCount} message(s)`);
        if (msgCount) {
          printCheckLogQ()
          for (const message of data.Messages) {
            await messageHandler(message, queue);
          }
        }
      } 
    } catch (e) {
      printCheckLogQ();
      console.error(`\n${new Date().toUTCString()} Queue receive error:`);
      console.error(e);
      await sleep(5);
      restart = true;
    }
  }

  while (true) {
    if (restart) {
      console.log(`${new Date().toUTCString()} Starting queue worker`);
      await startQueue();
      await sleep(5);
      restart = false;
    }
    await sleep(5);
  }
}


/**
 * Check that we can get a DocuSign token and handle common error
 * cases: ds_configuration not configured, need consent.
 */
async function testToken() {  
  try {
    if (! dsConfig.clientId || dsConfig.clientId == '{CLIENT_ID}') {
      console.log (`
Problem: you need to configure this example, either via environment variables (recommended) 
         or via the ds_configuration.js file. 
         See the README file for more information\n\n`);
      process.exit();
    }
  
    await dsJwtAuth.checkToken();
  } catch (e) {
    let body = e.response && e.response.body;
    if (body) {
      // DocuSign API problem
      if (body.error && body.error == 'consent_required') {
        // Consent problem
        let consent_scopes = "signature%20impersonation",
            consent_url = `https://${dsConfig.authServer}/oauth/auth?response_type=code&` +
              `scope=${consent_scopes}&client_id=${dsConfig.clientId}&` +
              `redirect_uri=${dsConfig.oAuthConsentRedirectURI}`;
        console.log(`\nProblem:   C O N S E N T   R E Q U I R E D
    Ask the user who will be impersonated to run the following url:
        ${consent_url}
    
    It will ask the user to login and to approve access by your application.
    
    Alternatively, an Administrator can use Organization Administration to
    pre-approve one or more users.\n\n`)
        process.exit();
      } else {
        // Some other DocuSign API problem 
        console.log (`\nAPI problem: Status code ${e.response.status}, message body:
${JSON.stringify(body, null, 4)}\n\n`);
        process.exit();
      }  
    } else {
      // Not an API problem
      throw e;
    }
  }
}

/* The mainline...            */
/* Start listening for jobs   */
listenForever()
