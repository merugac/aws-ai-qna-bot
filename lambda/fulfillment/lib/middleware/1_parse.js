var Promise = require('bluebird')
var lex = require('./lex')
var multilanguage = require('./multilanguage')
var get_sentiment=require('./sentiment');
var alexa = require('./alexa')
var _ = require('lodash')
var AWS = require('aws-sdk');

function isJson(str) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
}

function str2bool(settings) {
    var new_settings = _.mapValues(settings, x => {
        if (_.isString(x)) {
            x = x.replace(/^"(.+)"$/,'$1');  // remove wrapping quotes
            if (x.toLowerCase() === "true") {
                return true ;
            }
            if (x.toLowerCase() === "false") {
                return false ;
            }
        }
        return x;
    });
    return new_settings;
}


async function get_parameter(param_name) {
    var ssm = new AWS.SSM();
    var params = {
        Name: param_name,
    };
    var response = await ssm.getParameter(params).promise();
    var settings = response.Parameter.Value ;
    if (isJson(settings)) {
        settings = JSON.parse(response.Parameter.Value);
        settings = str2bool(settings) ;
    }
    return settings;
}

async function get_settings() {
    var default_jwks_param = process.env.DEFAULT_USER_POOL_JWKS_PARAM;
    var default_settings_param = process.env.DEFAULT_SETTINGS_PARAM;
    var custom_settings_param = process.env.CUSTOM_SETTINGS_PARAM;

    console.log("Getting Default JWKS URL from SSM Parameter Store: ", default_jwks_param);
    var default_jwks_url = await get_parameter(default_jwks_param);

    console.log("Getting Default QnABot settings from SSM Parameter Store: ", default_settings_param);
    var default_settings = await get_parameter(default_settings_param);

    console.log("Getting Custom QnABot settings from SSM Parameter Store: ", custom_settings_param);
    var custom_settings = await get_parameter(custom_settings_param);

    var settings = _.merge(default_settings, custom_settings);
    _.set(settings, "DEFAULT_USER_POOL_JWKS_URL", default_jwks_url);

    console.log("Merged Settings: ", settings);

    if (settings.ENABLE_REDACTING) {
        console.log("redacting enabled");
        process.env.QNAREDACT="true";
        process.env.REDACTING_REGEX=settings.REDACTING_REGEX;
    } else {
        console.log("redacting disabled");
        process.env.QNAREDACT="false";
        process.env.REDACTING_REGEX="";
    }
    return settings;
}

// makes best guess as to lex client type in use based on fields in req.. not perfect
function getClientType(req) {
    if (req._type == 'ALEXA') {
        return req._type ;
    }
    // Try to determine which Lex client is being used based on patterns in the req - best effort attempt.
    const voiceortext = (req._preferredResponseType == 'SSML') ? "Voice" : "Text" ;
    // Amazon Connect indicates support for SSML using request header x-amz-lex:accept-content-types
    if (_.get(req,"_event.requestAttributes.x-amz-lex:accept-content-types")) {
        return "LEX.AmazonConnect." + voiceortext ;
    } else if (_.get(req,"_event.requestAttributes.x-amz-lex:channel-type") == "Twilio-SMS") {
        return "LEX.TwilioSMS." + voiceortext ;
    } else if (/^.*-.*-\d:.*-.*-.*-.*$/.test(_.get(req,"_event.userId"))){
        // user id pattern to detect lex-web-uithrough use of cognito id as userId: e.g. us-east-1:a8e1f7b2-b20d-441c-9698-aff8b519d8d5
        // TODO: add another clientType indicator for lex-web-ui?
        return "LEX.LexWebUI." + voiceortext ;
    } else {
        // generic LEX client
        return "LEX." + voiceortext ;
    }
}


module.exports = async function parse(req, res) {

    // Add QnABot settings from Parameter Store
    var settings = await get_settings();
    _.set(req, "_settings", settings);

    req._type = req._event.version ? "ALEXA" : "LEX"

    switch (req._type) {
        case 'LEX':
            Object.assign(req, await lex.parse(req))
            _.set(req,"_preferredResponseType","PlainText") ;
            // Determine preferred response message type - PlainText, or SSML
            const outputDialogMode = _.get(req,"_event.outputDialogMode");
            if (outputDialogMode == "Voice") {
                _.set(req,"_preferredResponseType","SSML") ;
            } else if (outputDialogMode == "Text") {
                // Amazon Connect uses outputDialogMode "Text" yet indicates support for SSML using request header x-amz-lex:accept-content-types
                const contentTypes = _.get(req,"_event.requestAttributes.x-amz-lex:accept-content-types","") ;
                if (contentTypes.includes("SSML")) {
                    _.set(req,"_preferredResponseType","SSML") ;
                }
            } else {
                console.log("WARNING: Unrecognised value for outputDialogMode:", outputDialogMode);
            }
            break;
        case 'ALEXA':
            Object.assign(req, await alexa.parse(req))
            _.set(req,"_preferredResponseType","SSML") ;
            break;
    }
    

    req._clientType = getClientType(req) ;


    // multilanguage support 
    if (_.get(settings, 'ENABLE_MULTI_LANGUAGE_SUPPORT')) {
        await multilanguage.set_multilang_env(req);
    }
    // end of multilanguage support 
    
    // get sentiment
    if (_.get(settings, 'ENABLE_SENTIMENT_SUPPORT')) {
        let sentiment = await get_sentiment(req.question);
        req.sentiment = sentiment.Sentiment ;
        req.sentimentScore = sentiment.SentimentScore ;
    } else {
        req.sentiment = "NOT_ENABLED";
        req.sentimentScore = {} ;
    }  

    Object.assign(res, {
        type: "PlainText",
        message: "",
        session: _.mapValues(_.omit(_.cloneDeep(req.session), ["appContext"]),
            x => {
                try {
                    return JSON.parse(x)
                } catch (e) {
                    return x
                }
            }),
        card: {
            send: false,
            title: "",
            text: "",
            url: ""
        }
    })
    // ensure res.session.qnabotcontext exists
    if ( ! _.get(res,"session.qnabotcontext")) {
        _.set(res,"session.qnabotcontext",{}) ;
    }
    return { req, res }
}