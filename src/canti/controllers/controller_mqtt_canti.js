const dbase_mqtt = require('../configs/database_canti');
const mqtt_connect = require('../../global_config/mqtt_config');
const {auth} = require('../../global_config/controllers/google_api');
const { google } = require('googleapis');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const findRemoveSync = require('find-remove')
const lsq = require('least-squares'); //Least square method to forecasting

require('dotenv').config()

// PATH name check on .env
TS_PATH = process.env.PAYLOAD_CANTI_TS // Now using TSjsn;
DATE_PATH = process.env.PAYLOAD_CANTI_DATE //Now using Datejsn;
WATERLEVEL_PATH = process.env.PAYLOAD_CANTI_WATERLEVEL //Now using tinggijsn; //change path based on data from raspberrypi
TEMP_PATH = process.env.PAYLOAD_CANTI_TEMP
VOLTAGE_PATH = process.env.PAYLOAD_CANTI_VOLTAGE

var { DATA_ID, TS, DATE, WATERLEVEL, TEMP, VOLTAGE,FORECAST30, FORECAST300, DATETIME } = [];

//Save ALERT and RMS data forecasting 
var ALERTLEVEL;
var RMSROOT;
var RMSTHRESHOLD;
var STATUSWARNING;
var FEEDLATENCY;

//FAILSAFE
if (TEMP===null){TEMP=49};
if (VOLTAGE===null){VOLTAGE=12.5};

module.exports = {

    // MQTT HANDLING
    async incomingData_canti(topic,message){

        // Handling data from topic 1 (data from raspberrypi)
        if (topic === process.env.TOPIC_CANTI1){
            
            // Save subscribed message to payload variable
            const payload = JSON.parse(message.toString());

            // Checking property of Time, Date, and Waterlevel. so it will never null
            if ((payload.hasOwnProperty(TS_PATH)) 
                && (payload.hasOwnProperty(DATE_PATH)) 
                && (payload.hasOwnProperty(WATERLEVEL_PATH))){

                if ((payload[TS_PATH] != null) 
                    && (payload[DATE_PATH] != null) 
                    && (payload[WATERLEVEL_PATH] != null)) {
                    
                    // Save Payload to a variable.       
                    TS = payload[TS_PATH]
                    DATE = payload[DATE_PATH];
                    WATERLEVEL = parseFloat(payload[WATERLEVEL_PATH]);

                    DATETIME = DATE +'T'+ TS;
                    DATA_ID = (Date.now()+(Math.floor(Math.random() * 999)));
                    FEEDLATENCY = Math.abs(Date.now()-Date.parse(DATETIME));
                    
                    //Data Duplication Check
                    var DuplicateCheck = await dbase_mqtt.query(`SELECT CASE WHEN EXISTS (SELECT datetime FROM mqtt_canti where id = ${DATA_ID}) THEN 1 ELSE 0 END`)
                    if (DuplicateCheck.rows[0].case === 0){ //If no duplicate then :
                        var count_canti = await dbase_mqtt.query(`SELECT count(*) from mqtt_canti`);
                        
                        //remove old data
                        if (count_canti.rows[0].count >= 500000){
                            dbCanti_delete_lastweek = await dbase_mqtt.query(`DELETE FROM mqtt_canti WHERE datetime < now()-'1 week'::interval`);
                            console.log(`[U_TEWS CANTI 002   ] Fast-table Cleaned`);
                        }   

                        // fetch data DB
                        var dataDB_canti = await dbase_mqtt.query(`
                        SELECT  
                        to_timestamp(floor((extract('epoch' from datetime) / 5 )) * 5) 
                        AT TIME ZONE 'UTC' as datetime,
                        COUNT(DISTINCT waterlevel),
                            AVG(waterlevel) as waterlevel,
                            AVG(voltage) as voltage,
                            AVG(temperature) as temperature,
                            AVG(alertlevel) as alertlevel	
                        FROM mqtt_canti 
                        where datetime >= now() - Interval '30 minute'
                        GROUP BY 1 
                        order by 1 desc
                        LIMIT 300
                        `);
                        if (dataDB_canti.rowCount === 0){
                            console.log("Database still empty. Waiting for new data");
                            dataArray = [DATA_ID, DATETIME, TS, DATE, 0, 0, 0, 0, 0, 0, 0, 0, 0]; 
                            insertQuery = await dbase_mqtt.query(`INSERT INTO mqtt_canti(id, datetime, time, date, waterlevel, voltage, temperature, 
                            forecast30, forecast300, rms, threshold, alertlevel, feedlatency) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,dataArray);
                        } else {
                            var pull30_length;
                            var dbCanti_dataLength = dataDB_canti.rowCount;
                            
                            if (payload.hasOwnProperty(TEMP_PATH)) {
                                TEMP = parseFloat(payload[TEMP_PATH]);
                            } else {
                                TEMP = (dataDB_canti.rows[0].temperature).toFixed(2); //use latest data from database if temperature not avasysilable
                            }   

                            if (payload.hasOwnProperty(VOLTAGE_PATH)) {
                                VOLTAGE = parseFloat(payload[VOLTAGE_PATH]);
                            } else {
                                VOLTAGE = (dataDB_canti.rows[0].voltage).toFixed(2); //use latest data from database if temperature not available
                            }

                            // Forecast 30
                            if (dbCanti_dataLength <= 30){
                                pull30_length = dbCanti_dataLength;
                            } else {
                                pull30_length = 30;
                            }
                            var timeSeries = []; var timeWater = [];
                            var rmsSquare = 0;   var rmsMean = 0;
                            timeSeries.push(30);
                            timeWater.push(WATERLEVEL);

                            for (i=0 ; i<=pull30_length-1; i++){
                                timeSeries.push(i);
                                timeWater.push(dataDB_canti.rows[i].waterlevel);
                            }   
                            timeSeries.reverse(); 
                            timeWater.reverse();
                            var forecast = lsq(timeSeries, timeWater);
                            FORECAST30 = parseFloat(forecast(31).toFixed(2));

                            // Forecast 300
                            var timeSeries_fc300 = []; var timeWater_fc300 = [];
                            timeSeries_fc300.push(300);
                            timeWater_fc300.push(WATERLEVEL);

                            for (i=0 ; i<=dataDB_canti.rowCount-1; i++){
                                timeSeries_fc300.push(i);
                                timeWater_fc300.push(dataDB_canti.rows[i].waterlevel);
                            }
                            timeSeries_fc300.reverse(); 
                            timeWater_fc300.reverse();//reverse descending data from db and mqtt

                            var forecast3 = lsq(timeSeries_fc300, timeWater_fc300);
                            FORECAST300 = parseFloat(forecast3(301).toFixed(2));

                            // Calculate RMS
                            for (i=0 ; i<=dataDB_canti.rowCount-1; i++){
                                dataDB = dataDB_canti.rows[i].alertlevel;
                                if (isNaN(dataDB)){
                                    quare = Math.pow(0, 2);
                                }else {
                                    quare = Math.pow((dataDB_canti.rows[i].alertlevel), 2);
                                }
                                rmsSquare = rmsSquare + quare;
                            }    
                            rmsMean = (rmsSquare / (dataDB_canti.rowCount));
                            RMSROOT = parseFloat(Math.sqrt(rmsMean).toFixed(2));
                            RMSTHRESHOLD = parseFloat((RMSROOT * 9).toFixed(2)); 

                            // ALERT logic
                            //Calculate Alert
                            ALERTLEVEL = (Math.abs(FORECAST300 - WATERLEVEL)).toFixed(2);
                            //console.log("ALERT : " + ALERTLEVEL);
                            if (ALERTLEVEL >= RMSTHRESHOLD) {STATUSWARNING = "WARNING";} else STATUSWARNING = "SAFE";

                            console.log(`[U_TEWS CANTI 002     ] OK. TIME : ${Date(DATETIME)}`);

                            dataArray = [DATA_ID, DATETIME, TS, DATE, WATERLEVEL, VOLTAGE, TEMP, FORECAST30, FORECAST300, RMSROOT, RMSTHRESHOLD, ALERTLEVEL, FEEDLATENCY]; 
                            insertQuery = await dbase_mqtt.query(`INSERT INTO mqtt_canti(id, datetime, time, date, waterlevel, voltage, temperature, 
                                forecast30, forecast300, rms, threshold, alertlevel, feedlatency) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,dataArray);
                            insertQuery = await dbase_mqtt.query(`INSERT INTO mqtt_canti_stored(id, datetime, time, date, waterlevel, voltage, temperature, 
                                forecast30, forecast300, rms, threshold, alertlevel, feedlatency) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,dataArray);

                            // PUBLISH DATA
                            
                            var isoDateString = new Date(DATETIME).toISOString();
                            const jsonToJRC = {"UTC_TIME":isoDateString, "LOCAL_TIME":DATETIME, "WATERLEVEL":WATERLEVEL, "DEVICE_TEMP":TEMP, "DEVICE_VOLTAGE":VOLTAGE}
                            const jsonToPublish = {
                                "DATETIME":DATETIME ,"TS" : TS, "Date":DATE, "tinggi":WATERLEVEL, "tegangan":VOLTAGE, 
                                "suhu":TEMP ,"frcst30":FORECAST30, "frcst300":FORECAST300, "alertlevel":ALERTLEVEL, "rms":RMSROOT, 
                                "threshold":RMSTHRESHOLD, "status":STATUSWARNING, "feedLatency":FEEDLATENCY
                            };

                            mqtt_connect.publish('pummaUTEWS/canti', JSON.stringify(jsonToJRC), {qos:2, retain:false});    
                            mqtt_connect.publish('pumma/canti',JSON.stringify(jsonToPublish), {qos: 2, retain:false}, (err) => {});
                        }

                    } else {
                        console.log(`[U_TEWS CANTI 002     ] ERROR Data Duplicated on time : ${DATETIME}`);
                    }    
                }
            }
        }

        if (topic === process.env.TOPIC_CANTI_IMAGE){
            const imagePayload = message.toString();
            fs.writeFile("src/canti/image/canti_b64string.txt", imagePayload, function(err) {
                if(err) {
                    return console.log(err);
                }
                //console.log("IMAGE [U_TEWS Canti] file was saved!");
            }); 

            let image = `data:image/jpeg;base64,${message}`
            var data = image.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFile(`src/canti/image/canti.png`, data, {encoding: 'base64'}, function(err) {
                if(err) {
                    return console.log(err);
                }
                console.log("[U_TEWS Canti 002     ] Image file was saved!");
            });

            let ts = new Date(Date.now());

            var monthFolder = ((ts.getMonth()+1));
            !fs.existsSync(`src/canti/image/${monthFolder}`) && fs.mkdirSync(`src/canti/image/${monthFolder}`);

            var dateFolder = (ts.getDate() +"-"+ (ts.getMonth()+1) +"-"+ ts.getFullYear());
            !fs.existsSync(`src/canti/image/${monthFolder}/${dateFolder}`) && fs.mkdirSync(`src/canti/image/${monthFolder}/${dateFolder}`);

            var datetimes = (ts.getDate() +"-"+ (ts.getMonth()+1) +"-"+ ts.getFullYear() + "_" + ts.getHours() +"."+ ts.getMinutes() +"."+ ts.getSeconds());
           
            // fs.writeFileSync(`src/canti/image/${monthFolder}/${dateFolder}/${datetimes}_canti.png`, data, {encoding: 'base64'}, function(err) {
            //     if(err) {
            //         return console.log(err);
            //     }
            // });

            // UPLOAD TO GOOGLE DRIVE
            const driveService = google.drive({
                version : 'v3', auth
            });

            const metadata = {
                'name' : `${datetimes}_canti.png`,
                'parents' : ['1jwpQf-t-o04wIBxHukOFyAHTC9juvfds']
            }
            
            let media = {
                MimeType: 'image/png',
                body : fs.createReadStream(`src/canti/image/canti.png`)
            }

            let response = await driveService.files.create({
                resource : metadata, 
                media : media,
                fields : 'id'
            })
        
            switch(response.status){
                case 200 : 
                    console.log('done ', response.data.id ) 
                    break;
            }
            

            
            const itemCount = fs.readdirSync('src/canti/image/').length;
            if (itemCount <= 50){
                fs.writeFile(`src/canti/image/${datetimes}_canti.png`, data, {encoding: 'base64'}, function(err) {
                    if(err) {
                        return console.log(err);
                    }
                });
            } else {
                var result = findRemoveSync('src/canti/image/', {
                    age: { seconds: 3600 },
                    extensions: '.png',
                    limit: 50
                });
                fs.writeFile(`src/canti/image/${datetimes}_canti.png`, data, {encoding: 'base64'}, function(err) {
                    if(err) {
                        return console.log(err);
                    }
                });
            }   
        }
    }
}