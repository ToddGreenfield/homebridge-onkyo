'use strict';

let Service
let Characteristic;
let Accessory;
var RxInputs;
var pollingtoevent = require('polling-to-event');
var round = require( 'math-round' );
var accessories = [];
var info = require('./package.json');

let RxTypes = require('./RxTypes.js');

class OnkyoPlatform {
	constructor(log, config, api) {
		this.api = api;
		this.config = config;
		this.log = log;
		this.receivers = this.config['receivers'];
		this.receiverAccessories = [];

		this.createAccessories(this, this.receivers);
	}

	createAccessories(platform, receivers) {
		platform.numberReceivers = platform.receivers.length;
		platform.log.debug("Creating %s receivers...", platform.numberReceivers);
	
		receivers.forEach(function(receiver) {
			var accessory = new OnkyoAccessory(platform, receiver);
			platform.receiverAccessories.push(accessory);
		})
	}

	accessories (callback) {
		callback(this.receiverAccessories);
	}
}


class OnkyoAccessory {	
	constructor (platform, receiver) {
		this.platform = platform;
		this.log = platform.log;
	// constructor(log, config) {
	// 	this.log = log;

		this.eiscp = require('eiscp');
		this.setAttempt = 0;
		this.enabledServices = [];

		this.config = receiver;
		// this.config = config;
		this.name = this.config["name"];
		this.ip_address	= this.config["ip_address"];
		this.model = this.config["model"];
		this.zone = this.config["zone"] || "main";
		this.inputs = this.config["inputs"];
		this.volume_dimmer = this.config["volume_dimmer"] || true;
		this.filter_inputs = this.config["filter_inputs"] || false;

		this.cmdMap = new Array();
		this.cmdMap["main"] = new Array();
		this.cmdMap["main"]["power"] = "system-power";
		this.cmdMap["main"]["volume"] = "master-volume";
		this.cmdMap["main"]["muting"] = "audio-muting";
		this.cmdMap["main"]["input"] = "input-selector";
		this.cmdMap["zone2"] = new Array();
		this.cmdMap["zone2"]["power"] = "power";
		this.cmdMap["zone2"]["volume"] = "volume";
		this.cmdMap["zone2"]["muting"] = "muting";
		this.cmdMap["zone2"]["input"] = "selector";

		this.poll_status_interval = this.config["poll_status_interval"] || "0";
		this.defaultInput = this.config["default_input"];
		this.defaultVolume = this.config['default_volume'];
		this.maxVolume = this.config['max_volume'] || 60;
		this.mapVolume100 = this.config['map_volume_100'] || true;

		this.buttons = {
			[Characteristic.RemoteKey.REWIND]: 'rew',
			[Characteristic.RemoteKey.FAST_FORWARD]: 'ff',
			[Characteristic.RemoteKey.NEXT_TRACK]: 'skip-f',
			[Characteristic.RemoteKey.PREVIOUS_TRACK]: 'skip-r',
			[Characteristic.RemoteKey.ARROW_UP]: 'up', // 4
			[Characteristic.RemoteKey.ARROW_DOWN]: 'down', // 5
			[Characteristic.RemoteKey.ARROW_LEFT]: 'left', // 6
			[Characteristic.RemoteKey.ARROW_RIGHT]: 'right', // 7
			[Characteristic.RemoteKey.SELECT]: 'enter', // 8
			[Characteristic.RemoteKey.BACK]: 'exit', // 9
			[Characteristic.RemoteKey.EXIT]: 'exit', // 10
			[Characteristic.RemoteKey.PLAY_PAUSE]: 'play', // 11
			[Characteristic.RemoteKey.INFORMATION]: 'home', // 15
		};

		this.state = false;
		this.m_state = false;
		this.v_state = 0;
		this.i_state = null;
		this.interval = parseInt(this.poll_status_interval);
		this.avrManufacturer = "Onkyo";
		this.avrSerial = this.config["serial"] || this.ip_address;

		this.switchHandling = "check";
		if (this.interval > 10 && this.interval < 100000) {
			this.switchHandling = "poll";
		}

		this.eiscp.on('debug', this.eventDebug.bind(this));
		this.eiscp.on('error', this.eventError.bind(this));
		this.eiscp.on('connect', this.eventConnect.bind(this));
		this.eiscp.on('close', this.eventClose.bind(this));
		this.eiscp.on(this.cmdMap[this.zone]["power"], this.eventSystemPower.bind(this));
		this.eiscp.on(this.cmdMap[this.zone]["volume"], this.eventVolume.bind(this));
		this.eiscp.on(this.cmdMap[this.zone]["muting"], this.eventAudioMuting.bind(this));
		this.eiscp.on(this.cmdMap[this.zone]["input"], this.eventInput.bind(this));

		this.eiscp.connect(
			{host: this.ip_address, reconnect: true, model: this.model}
		);

		this.setUp();
	}

	setUp() {
		this.createRxInput();
		this.polling(this);

		const infoService = this.createAccessoryInformationService();
		this.enabledServices.push(infoService);
		this.tvService = this.createTvService();
		this.enabledServices.push(this.tvService);
		this.createTvSpeakerService(this.tvService);
		this.enabledServices.push(...this.addSources(this.tvService));
		if (this.volume_dimmer) {
			this.log.debug("Creating Dimmer service linked to TV for receiver %s", this.name)
			this.createVolumeDimmer(this.tvService);
		}
	}

	getServices() {
		return this.enabledServices;
	}
	
	createRxInput() {
	// Create the RxInput object for later use.
		var eiscpData = require('./node_modules/eiscp/eiscp-commands.json');
		var inSets = [];
		for (set in eiscpData.modelsets) {
			eiscpData.modelsets[set].forEach(model => {
				if (model.includes(this.model)) {
					inSets.push(set);
				}
			});
		}
		
		
		var eiscpData = eiscpData.commands.main.SLI.values;
		var newobj = '{ "Inputs" : [';
		for (var exkey in eiscpData) {
			var hold = eiscpData[exkey].name.toString();
			if (hold.includes(',')) {
				hold = hold.substring(0,hold.indexOf(','));
			}
			if (exkey.includes('“') || exkey.includes('“')) {
				exkey = exkey.replace(/\“/g, "");
				exkey = exkey.replace(/\”/g, "");
			}
			if (exkey.includes("UP") || exkey.includes("DOWN") || exkey.includes("QSTN")) {
				continue
			}
			var set = eiscpData[exkey]['models']
			if (inSets.includes(set)) {
				newobj = newobj + '{ "code":"'+exkey+'" , "label":"'+hold+'" },';
			} else {
				continue
			}
		}
		// Drop last comma first
		newobj = newobj.slice(0,-1) + ']}';
		RxInputs = JSON.parse(newobj);
		if (this.filter_inputs) {
			var length = RxInputs['Inputs'].length;
			while(length--) {
				if (this.inputs[RxInputs['Inputs'][length].label]) {
					continue
				} else {
					RxInputs['Inputs'].splice(length, 1);
				}
			}
		}
		// Deduplicate any input entries.
		// Is this necessary?
		// var tempRxInputs = JSON.parse(newobj);
		// var deduped = [];
		// tempRxInputs['Inputs'].forEach((input, index) => {
		// 	var dupe = false;
		// 	deduped.forEach((input2, index2) => {
		// 		if (input2 == input) {
		// 			dupe = true;
		// 			return
		// 		}
		// 	})
		// 	if (!dupe) {
		// 		deduped.push(input);
		// 	}
		// })
		// tempRxInputs.Inputs = deduped;
		// RxInputs = tempRxInputs;
		// this.log.info(tempRxInputs);
	}

	polling(platform) {
		var that = platform
	// Status Polling
		if (that.switchHandling == "poll") {
			var powerurl = that.status_url;
			that.log.debug("start long poller..");
	// PWR Polling
			var statusemitter = pollingtoevent(function(done) {
				that.log.debug("start PWR polling..");
				that.getPowerState( function( error, response) {
					//pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, "statuspoll");
			}, {longpolling:true,interval:that.interval * 1000,longpollEventName:"statuspoll"});

			statusemitter.on("statuspoll", function(data) {
				that.state = data;
				that.log.debug("event - PWR status poller - new state: ", that.state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.Active).updateValue(that.state, null, "statuspoll");
				// }
			});
	// Audio-Input Polling
			var i_statusemitter = pollingtoevent(function(done) {
				that.log.debug("start INPUT polling..");
				that.getInputSource( function( error, response) {
					//pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, "i_statuspoll");
			}, {longpolling:true,interval:that.interval * 1000,longpollEventName:"i_statuspoll"});

			i_statusemitter.on("i_statuspoll", function(data) {
				that.i_state = data;
				that.log.debug("event - INPUT status poller - new i_state: ", that.i_state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(that.i_state, null, "i_statuspoll");
				// }
			});
	// Audio-Muting Polling
			var m_statusemitter = pollingtoevent(function(done) {
				that.log.debug("start MUTE polling..");
				that.getMuteState( function( error, response) {
					//pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, "m_statuspoll");
			}, {longpolling:true,interval:that.interval * 1000,longpollEventName:"m_statuspoll"});

			m_statusemitter.on("m_statuspoll", function(data) {
				that.m_state = data;
				that.log.debug("event - MUTE status poller - new m_state: ", that.m_state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.Mute).updateValue(that.m_state, null, "m_statuspoll");
				// }
			});
	// Volume Polling
			var v_statusemitter = pollingtoevent(function(done) {
				that.log.debug("start VOLUME polling..");
				that.getVolumeState( function( error, response) {
					//pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, "v_statuspoll");
			}, {longpolling:true,interval:that.interval * 1000,longpollEventName:"v_statuspoll"});

			v_statusemitter.on("v_statuspoll", function(data) {
				that.v_state = data;
				that.log.debug("event - VOLUME status poller - new v_state: ", that.v_state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.Volume).updateValue(that.v_state, null, "v_statuspoll");
				// }
			});
		}
	}

	///////////////////
	// EVENT FUNCTIONS
	///////////////////
	eventDebug(response) {
		this.log.debug( "eventDebug: %s", response);
	}

	eventError(response) {
		this.log.error( "eventError: %s", response);
	}

	eventConnect(response) {
		this.log.debug( "eventConnect: %s", response);
		this.reachable = true;
	}

	eventSystemPower(response) {
		if (this.state != (response == "on")) {
			this.log.info("Event - System Power changed: %s", response);
		}
		this.state = (response == "on");
		this.log.debug("eventSystemPower - message: %s, new state %s", response, this.state);
		//Communicate status
		// if (this.tvService ) {
		// 	this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state, null, "statuspoll");
		// }
		// if (this.volume_dimmer) {
		// 	this.m_state = !(response == "on");
		// 	this.dimmer.getCharacteristic(Characteristic.On).updateValue((response == "on"), null, "power event m_status");
		// }
	}

	eventAudioMuting(response) {
		this.m_state = (response == "on");
		this.log.debug("eventAudioMuting - message: %s, new m_state %s", response, this.m_state);
		//Communicate status
		if (this.tvService ) {
			this.tvService.getCharacteristic(Characteristic.Mute).updateValue(this.m_state, null, "m_statuspoll");
		}
	}

	eventInput(response) {
		if (response) {
			var input = JSON.stringify(response);
			input = input.replace(/[\[\]"]+/g,'');
			if (input.includes(',')) {
				input = input.substring(0,input.indexOf(','));
			}
			// Convert to i_state input code
			const index = 
				input !== null
				? RxInputs.Inputs.findIndex(i => i.label == input)
				: -1;
			if (this.i_state != (index + 1)) {
				this.log.info("Event - Input changed: %s", input);
			}
			this.i_state = index + 1;

			this.log.debug("eventInput - message: %s - new i_state: %s - input: %s", response, this.i_state, input);
			// this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.i_state);
		} else {
			// Then invalid Input chosen
			this.log.error("eventInput - ERROR - INVALID INPUT - Model does not support selected input.");
		}
		this.getInputSource.bind(this);
	}

	eventVolume(response) {
		if (this.mapVolume100) {
			var volumeMultiplier = this.maxVolume/100;
			var newVolume = response / volumeMultiplier;
			this.v_state = round(newVolume);
			this.log.debug("eventVolume - message: %s, new v_state %s PERCENT", response, this.v_state);
		} else {
			this.v_state = response;
			this.log.debug("eventVolume - message: %s, new v_state %s ACTUAL", response, this.v_state);
		}
		//Communicate status
		if (this.tvService ) {
			this.tvService.getCharacteristic(Characteristic.Volume).updateValue(this.v_state, null, "v_statuspoll");
		}
	}

	eventClose (response) {
		this.log.debug( "eventClose: %s", response);
		this.reachable = false;
	}

	////////////////////////
	// GET AND SET FUNCTIONS
	////////////////////////
	setPowerState(powerOn, callback, context) {
	//if context is statuspoll, then we need to ensure this we do not set the actual value
		if (context && context == "statuspoll") {
			this.log.debug( "setPowerState - polling mode, ignore, state: %s", this.state);
			callback(null, this.state);
			return;
		}
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		this.setAttempt = this.setAttempt+1;
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		this.state = powerOn;
		callback( null, this.state);
		if (powerOn) {
			this.log.debug("setPowerState - actual mode, power state: %s, switching to ON", this.state);
			this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["power"] + "=on", function(error, response) {
				//this.log.debug( "PWR ON: %s - %s -- current state: %s", error, response, this.state);
				if (error) {
					this.state = false;
					this.log.error( "setPowerState - PWR ON: ERROR - current state: %s", this.state);
					// if (this.tvService ) {
					// 	this.tvService.getCharacteristic(Characteristic.Active).updateValue(powerOn, null, "statuspoll");
					// }
				} else {
					// If the AVR has just been turned on, apply the default volume
						this.log.debug("Attempting to set the default volume to "+this.defaultVolume);
						if (powerOn && this.defaultVolume) {
							this.log.info("Setting default volume to "+this.defaultVolume);
							this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["volume"] + ":"+this.defaultVolume, function(error, response) {
								if (error) {
									this.log.error( "Error while setting default volume: %s", error);
								}
							});
						}
					// If the AVR has just been turned on, apply the Input default
						this.log.debug("Attempting to set the default input selector to "+this.defaultInput);

						// Handle defaultInput being either a custom label or manufacturer label
						var label = this.defaultInput;
						if (this.inputs) {
							for (var id in this.inputs) {
								if (this.inputs[id] == this.defaultInput) {
									label = id
								}
							}
						}
						const index = 
							label !== null
							? RxInputs.Inputs.findIndex(i => i.label == label)
							: -1;
						this.i_state = index + 1;
						
						if (powerOn && label) {
							this.log.info("Setting default input selector to "+label);
							this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["input"] + "="+label, function(error, response) {
								if (error) {
									this.log.error( "Error while setting default input: %s", error);
								}
							});
						}
				}
			}.bind(this) );
		} else {
			this.log.debug("setPowerState - actual mode, power state: %s, switching to OFF", this.state);
			this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["power"] + "=standby", function(error, response) {
				//this.log.debug( "PWR OFF: %s - %s -- current state: %s", error, response, this.state);
				if (error) {
					this.state = false;
					this.log.error( "setPowerState - PWR OFF: ERROR - current state: %s", this.state);
					// if (this.tvService ) {
					// 	this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state, null, "statuspoll");
					// }
				}
			}.bind(this) );
		}

		// if (this.volume_dimmer) {
		// 	this.m_state = !(powerOn == "on");
		// 	this.dimmer.getCharacteristic(Characteristic.On).updateValue((powerOn == "on"), null, "power event m_status");
		// }
		// this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state, null, "statuspoll");
	}
	
	getPowerState(callback, context) {
		//if context is statuspoll, then we need to request the actual value
		if (!context || context != "statuspoll") {
			if (this.switchHandling == "poll") {
				this.log.debug("getPowerState - polling mode, return state: ", this.state);
				callback(null, this.state);
				return;
			}
		}
	
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback(null, this.state);
		this.log.debug("getPowerState - actual mode, return state: ", this.state);
		this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["power"] + "=query", function( error, data) {
			if (error) {
				this.state = false;
				this.log.debug( "getPowerState - PWR QRY: ERROR - current state: %s", this.state);
			}
		}.bind(this) );
		// this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state);
	}
	
	getVolumeState(callback, context) {
		//if context is v_statuspoll, then we need to request the actual value
		if (!context || context != "v_statuspoll") {
			if (this.switchHandling == "poll") {
				this.log.debug("getVolumeState - polling mode, return v_state: ", this.v_state);
				callback(null, this.v_state);
				return;
			}
		}
	
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback(null, this.v_state);
		this.log.debug("getVolumeState - actual mode, return v_state: ", this.v_state);
		this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["volume"] + "=query", function( error, data) {
			if (error) {
				this.v_state = 0;
				this.log.debug( "getVolumeState - VOLUME QRY: ERROR - current v_state: %s", this.v_state);
			}
		}.bind(this) );
	}
	
	setVolumeState(volumeLvl, callback, context) {
	//if context is v_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context == "v_statuspoll") {
			this.log.debug( "setVolumeState - polling mode, ignore, v_state: %s", this.v_state);
			callback(null, this.v_state);
			return;
		}
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		this.setAttempt = this.setAttempt+1;
	
		//Are we mapping volume to 100%?
		if (this.mapVolume100) {
			var volumeMultiplier = this.maxVolume/100;
			var newVolume = volumeMultiplier * volumeLvl;
			this.v_state = round(newVolume);
			this.log.debug("setVolumeState - actual mode, PERCENT, volume v_state: %s", this.v_state);
		} else if (volumeLvl > this.maxVolume) {
		//Determin if maxVolume threshold breached, if so set to max.
			this.v_state = this.maxVolume;
			this.log.debug("setVolumeState - VOLUME LEVEL of: %s exceeds maxVolume: %s. Resetting to max.", volumeLvl, this.maxVolume);
		} else {
		// Must be using actual volume number
			this.v_state = volumeLvl;
			this.log.debug("setVolumeState - actual mode, ACTUAL volume v_state: %s", this.v_state);
		}
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback( null, this.v_state);
	
		this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["volume"] + ":" + this.v_state, function(error, response) {
			if (error) {
				this.v_state = 0;
				this.log.debug( "setVolumeState - VOLUME : ERROR - current v_state: %s", this.v_state);
			}
		}.bind(this) );
	}
	
	setVolumeRelative(volumeDirection, callback, context) {
	//if context is v_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context == "v_statuspoll") {
			this.log.debug( "setVolumeRelative - polling mode, ignore, v_state: %s", this.v_state);
			callback(null, this.v_state);
			return;
		}
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		this.setAttempt = this.setAttempt+1;
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback( null, this.v_state);
		if (volumeDirection == Characteristic.VolumeSelector.INCREMENT) {
			this.log.debug("setVolumeRelative - VOLUME : level-up")
			this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["volume"] + ":" + "level-up", function(error, response) {
				if (error) {
					this.v_state = 0;
					this.log.error( "setVolumeRelative - VOLUME : ERROR - current v_state: %s", this.v_state);
				}
			}.bind(this) );
		} else if (volumeDirection == Characteristic.VolumeSelector.DECREMENT) {
			this.log.debug("setVolumeRelative - VOLUME : level-down")
			this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["volume"] + ":" + "level-down", function(error, response) {
				if (error) {
					this.v_state = 0;
					this.log.error( "setVolumeRelative - VOLUME : ERROR - current v_state: %s", this.v_state);
				}
			}.bind(this) );
		} else {
			this.log.error( "setVolumeRelative - VOLUME : ERROR - unknown direction sent");
		}
	}
	
	getMuteState(callback, context) {
		//if context is m_statuspoll, then we need to request the actual value
		if (!context || context != "m_statuspoll") {
			if (this.switchHandling == "poll") {
				this.log.debug("getMuteState - polling mode, return m_state: ", this.m_state);
				callback(null, this.m_state);
				return;
			}
		}
	
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback(null, this.m_state);
		this.log.debug("getMuteState - actual mode, return m_state: ", this.m_state);
		this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["muting"] + "=query", function( error, data) {
			if (error) {
				this.m_state = false;
				this.log.debug( "getMuteState - MUTE QRY: ERROR - current m_state: %s", this.m_state);
			}
		}.bind(this) );
	}
	
	setMuteState(muteOn, callback, context) {
	//if context is m_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context == "m_statuspoll") {
			this.log.debug( "setMuteState - polling mode, ignore, m_state: %s", this.m_state);
			callback(null, this.m_state);
			return;
		}
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		this.setAttempt = this.setAttempt+1;
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		this.m_state = muteOn;
		callback( null, this.m_state);
		if (this.m_state) {
			this.log.debug("setMuteState - actual mode, mute m_state: %s, switching to ON", this.m_state);
			this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["muting"] + "=on", function(error, response) {
				if (error) {
					this.m_state = false;
					this.log.error( "setMuteState - MUTE ON: ERROR - current m_state: %s", this.m_state);
				}
			}.bind(this) );
		} else {
			this.log.debug("setMuteState - actual mode, mute m_state: %s, switching to OFF", this.m_state);
			this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["muting"] + "=off", function(error, response) {
				if (error) {
					this.m_state = false;
					this.log.error( "setMuteState - MUTE OFF: ERROR - current m_state: %s", this.m_state);
				}
			}.bind(this) );
		}
	}
	
	getInputSource(callback, context) {
		//if context is i_statuspoll, then we need to request the actual value
		// if (!context || context != "i_statuspoll") {
		// 	if (this.switchHandling == "poll") {
		// 		this.log.debug("getInputState - polling mode, return i_state: ", this.i_state);
		// 		callback(null, this.i_state);
		// 		return;
		// 	}
		// }
	
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		
		
		this.log.debug("getInputState - actual mode, return i_state: ", this.i_state);
		this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["input"] + "=query", function( error, data) {
			if (error) {
				this.i_state = 1;
				this.log.error( "getInputState - INPUT QRY: ERROR - current i_state: %s", this.i_state);
			}
		}.bind(this) );
		callback(null, this.i_state);
		// this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.i_state);
	}
	
	setInputSource(source, callback, context) {
	//if context is i_statuspoll, then we need to ensure this we do not set the actual value
		// if (context && context == "i_statuspoll") {
		// 	this.log.info( "setInputState - polling mode, ignore, i_state: %s", this.i_state);
		// 	callback(null, this.i_state);
		// 	return;
		// }
		if (!this.ip_address) {
			this.log.error("Ignoring request; No ip_address defined.");
			callback(new Error("No ip_address defined."));
			return;
		}
	
		this.setAttempt = this.setAttempt+1;

		this.i_state = source;
		const label = RxInputs.Inputs[this.i_state - 1].label;

		this.log.debug("setInputState - actual mode, ACTUAL input i_state: %s - label: %s", this.i_state, label);
	
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback(null, this.i_state);
		this.eiscp.command(this.zone + "." + this.cmdMap[this.zone]["input"] + ":" + label, function(error, response) {
			if (error) {
				this.log.error( "setInputState - INPUT : ERROR - current i_state:%s - Source:%s", this.i_state, source.toString());
			}
		}.bind(this) );
	}
	
	remoteKeyPress(button, callback) {
		//do the callback immediately, to free homekit
		//have the event later on execute changes
		callback(null, button);
		if (this.buttons[button]) {
			var press = this.buttons[button]
			this.log.debug("remoteKeyPress - INPUT: pressing key %s", press);
			this.eiscp.command(this.zone + "." + "setup=" + press, function( error, data) {
				if (error) {
					// this.i_state = 1;
					this.log.error( "remoteKeyPress - INPUT: ERROR pressing button %s", press);
				}
			}.bind(this) );
		} else {
			this.log.error('Remote button %d not supported.', button)
		}
	}
	
	identify(callback) {
		this.log.info("Identify requested! %s", this.ip_address);
		callback(); // success
	}

	////////////////////////
	// TV SERVICE FUNCTIONS
	////////////////////////
	addSources(service) {
		// If input name mappings are provided, use them.
		// Option to only configure specified inputs with filter_inputs
		if (this.filter_inputs) {
			var length = RxInputs['Inputs'].length;
			while(length--) {
				if (this.inputs[RxInputs['Inputs'][length].label]) {
					continue
				} else {
					RxInputs['Inputs'].splice(length, 1);
				}
			}
		}
		this.log.debug(RxInputs['Inputs']);
		const inputs = RxInputs['Inputs'].map((i, index) => {
			const hapId = index + 1;
			var inputName = i['label'];
			if (this.inputs) {
				if (this.inputs[i['label']]) {
					inputName = this.inputs[i['label']];		
				}
			}
			// var dupe = false;
			// inputs.forEach((y, z) => {
			// 	if (y['subtype'] == i['code']) {
			// 		dupe = true;
			// 	}
			// })

			// if (dupe) return
			const input = this.setupInput(i.code, inputName, hapId, service);
			return input;
		});
		return inputs;
	}

	setupInput(inputCode, name, hapId, television) {	
		const input = new Service.InputSource(`${this.name} ${name}`, inputCode);
		const inputSourceType = Characteristic.InputSourceType.HDMI

		input
			.setCharacteristic(Characteristic.Identifier, hapId)
			.setCharacteristic(Characteristic.ConfiguredName, name)
			.setCharacteristic(
			Characteristic.IsConfigured,
			Characteristic.IsConfigured.CONFIGURED
			)
			.setCharacteristic(Characteristic.InputSourceType, inputSourceType);

		input.getCharacteristic(Characteristic.ConfiguredName).setProps({
			perms: [Characteristic.Perms.READ]
		});

		television.addLinkedService(input);
		return input;
	}

	createAccessoryInformationService() {
		const informationService = new Service.AccessoryInformation();
		informationService
			.setCharacteristic(Characteristic.Manufacturer, this.avrManufacturer)
			.setCharacteristic(Characteristic.Model, this.model)
			.setCharacteristic(Characteristic.SerialNumber, this.avrSerial)
			.setCharacteristic(Characteristic.FirmwareRevision, info.version)
			.setCharacteristic(Characteristic.Name, this.name);
		
		return informationService;
	}
	
	createVolumeDimmer(service) {
		this.dimmer = new Service.Lightbulb(this.name + ' Volume', 'dimmer');
		this.dimmer
			.getCharacteristic(Characteristic.On)
			// Inverted logic taken from https://github.com/langovoi/homebridge-upnp
			.on('get', (callback) => {
				this.getMuteState((err, value) => {
					if (err) {
						callback(err);
						return;
					}
	
					callback(null, !value);
				})
			})
			.on('set', (value, callback) => this.setMuteState(!value, callback));
		this.dimmer
			.addCharacteristic(Characteristic.Brightness)
			.on('get', this.getVolumeState.bind(this))
			.on('set', this.setVolumeState.bind(this));
		
		service.addLinkedService(this.dimmer);
		this.enabledServices.push(this.dimmer);
	}

	createTvService() {
		this.log.debug("Creating TV service for receiver %s", this.name)
		const tvService = new Service.Television(this.name);
	
		tvService
			.getCharacteristic(Characteristic.ConfiguredName)
			.setValue(this.name)
			.setProps({
				perms: [Characteristic.Perms.READ]
			});
		
		tvService
			.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
		
		tvService
			.getCharacteristic(Characteristic.Active)
			.on('get', this.getPowerState.bind(this))
			.on('set', this.setPowerState.bind(this));
	
		tvService
			.getCharacteristic(Characteristic.ActiveIdentifier)
			.on('set', this.setInputSource.bind(this))
			.on('get', this.getInputSource.bind(this));
		
		tvService
			.getCharacteristic(Characteristic.RemoteKey)
			.on('set', this.remoteKeyPress.bind(this));

		return tvService;
	}

	createTvSpeakerService(tvService) {

		this.tvSpeakerService = new Service.TelevisionSpeaker(this.name + ' Volume', 'tvSpeakerService');
		this.tvSpeakerService
			.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
			.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
		this.tvSpeakerService
			.getCharacteristic(Characteristic.VolumeSelector)
			.on('set', this.setVolumeRelative.bind(this));
		this.tvSpeakerService
			.getCharacteristic(Characteristic.Mute)
			.on('get', this.getMuteState.bind(this))
			.on('set', this.setMuteState.bind(this));
		this.tvSpeakerService
			.addCharacteristic(Characteristic.Volume)
			.on('get', this.getVolumeState.bind(this))
			.on('set', this.setVolumeState.bind(this));
	
		tvService.addLinkedService(this.tvSpeakerService);
		this.enabledServices.push(this.tvSpeakerService);
	}

}


module.exports = (homebridge) =>
{
  ({ Service, Characteristic } = homebridge.hap);
  homebridge.registerPlatform("homebridge-onkyo", "Onkyo", OnkyoPlatform);
}
