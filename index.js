'use strict';
/* eslint arrow-body-style: ["off", "never"] */

let Service;
let Characteristic;
let RxInputs;
const pollingtoevent = require('polling-to-event');
const info = require('./package.json');

class OnkyoPlatform {
	constructor(log, config, api) {
		this.api = api;
		this.config = config;
		this.log = log;
		this.receivers = this.config.receivers;
		this.receiverAccessories = [];
		this.connections = {};

		if (this.receivers === undefined) {
			this.log.error('ERROR: your configuration is incorrect. Configuration changed with version 0.7.x');
			this.receivers = '';
		}

		this.createAccessories(this, this.receivers);
	}

	createAccessories(platform, receivers) {
		platform.numberReceivers = platform.receivers.length;
		platform.log.debug('Creating %s receivers...', platform.numberReceivers);
		if (platform.numberReceivers === 0) return;
		receivers.forEach(receiver => {
			if (!this.connections[receiver.ip_address]) {
				platform.log.debug('Creating new connection for ip %s', receiver.ip_address);
				this.connections[receiver.ip_address] = require('eiscp');
				this.connections[receiver.ip_address].connect({host: receiver.ip_address, reconnect: true, model: receiver.model});
			}

			const accessory = new OnkyoAccessory(platform, receiver); // eslint-disable-line no-unused-vars
			});
	}
}

class OnkyoAccessory {
	constructor(platform, receiver) {
		this.platform = platform;
		this.log = platform.log;

		this.log.info('**************************************************************');
		this.log.info('  homebridge-onkyo version ' + info.version);
		this.log.info('  GitHub: https://github.com/ToddGreenfield/homebridge-onkyo ');
		this.log.info('**************************************************************');
		this.log.info('start success...');
		this.log.debug('Debug mode enabled');

		this.eiscp = platform.connections[receiver.ip_address];
		this.setAttempt = 0;

		this.config = receiver;
		this.name = this.config.name;
		this.log.debug('name %s', this.name);
		this.ip_address	= this.config.ip_address;
		this.log.debug('IP %s', this.ip_address);
		this.model = this.config.model;
		this.log.debug('Model %s', this.model);
		this.zone = (this.config.zone || 'main').toLowerCase();
		this.log.debug('Zone %s', this.zone);

		if (this.config.volume_type === undefined) {
			this.log.error('ERROR: Your configuration is missing the parameter "volume_type". Assuming "none".');
			this.volume_type = 'none';
		} else {
			this.volume_type = this.config.volume_type;
			this.log.debug('volume_type: %s', this.volume_type);
		}

		if (this.config.filter_inputs === undefined) {
			this.log.error('ERROR: Your configuration is missing the parameter "filter_inputs". Assuming "false".');
			this.filter_inputs = false;
		} else {
			this.filter_inputs = this.config.filter_inputs;
			this.log.debug('filter_inputs: %s', this.filter_inputs);
		}

		this.inputs = this.config.inputs;

		this.cmdMap = new Array(2);
		this.cmdMap.main = new Array(4);
		this.cmdMap.main.power = 'system-power';
		this.cmdMap.main.volume = 'master-volume';
		this.cmdMap.main.muting = 'audio-muting';
		this.cmdMap.main.input = 'input-selector';
		this.cmdMap.zone2 = new Array(4);
		this.cmdMap.zone2.power = 'power';
		this.cmdMap.zone2.volume = 'volume';
		this.cmdMap.zone2.muting = 'muting';
		this.cmdMap.zone2.input = 'selector';

		this.poll_status_interval = this.config.poll_status_interval || '0';
		this.log.debug('poll_status_interval: %s', this.poll_status_interval);
		this.defaultInput = this.config.default_input;
		this.log.debug('defaultInput: %s', this.defaultInput);
		this.defaultVolume = this.config.default_volume;
		this.log.debug('defaultVolume: %s', this.defaultVolume);
		this.maxVolume = this.config.max_volume || 60;
		this.log.debug('maxVolume: %s', this.maxVolume);
		this.mapVolume100 = this.config.map_volume_100 || true;
		this.log.debug('mapVolume100: %s', this.mapVolume100);

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
		this.interval = Number.parseInt(this.poll_status_interval, 10);
		this.avrManufacturer = 'Onkyo';
		this.avrSerial = this.config.serial || this.ip_address;
		this.log.debug('avrSerial: %s', this.avrSerial);
		this.switchHandling = 'check';
		if (this.interval > 10 && this.interval < 100000)
			this.switchHandling = 'poll';

		this.eiscp.on('debug', this.eventDebug.bind(this));
		this.eiscp.on('error', this.eventError.bind(this));
		this.eiscp.on('connect', this.eventConnect.bind(this));
		this.eiscp.on('close', this.eventClose.bind(this));
		this.eiscp.on(this.cmdMap[this.zone].power, this.eventSystemPower.bind(this));
		this.eiscp.on(this.cmdMap[this.zone].volume, this.eventVolume.bind(this));
		this.eiscp.on(this.cmdMap[this.zone].muting, this.eventAudioMuting.bind(this));
		this.eiscp.on(this.cmdMap[this.zone].input, this.eventInput.bind(this));

		this.setUp();
	}

	setUp() {
		this.createRxInput();
		this.polling(this);

		this.UUID = this.platform.api.hap.uuid.generate('homebridge:homebridge-onkyo' + this.name);
		this.accessory = new this.platform.api.platformAccessory(this.name, this.UUID, this.platform.api.hap.Accessory.Categories.AUDIO_RECEIVER); // eslint-disable-line new-cap

		this.createAccessoryInformationService(this.accessory);
		this.tvService = this.createTvService(this.accessory);
		this.createTvSpeakerService(this.tvService);
		this.addSources(this.tvService);
		if (this.volume_type) {
			this.log.debug('Creating Dimmer service linked to TV for receiver %s', this.name);
			this.createVolumeType(this.tvService);
		}

		this.platform.api.publishExternalAccessories('homebridge-onkyo', [this.accessory]);
	}

	createRxInput() {
	// Create the RxInput object for later use.
		const eiscpDataAll = require('eiscp/eiscp-commands.json');
		const inSets = [];
		let set;
/* eslint guard-for-in: "off" */
		for (set in eiscpDataAll.modelsets) {
			eiscpDataAll.modelsets[set].forEach(model => {
				if (model.includes(this.model))
					inSets.push(set);
			});
		}

		// Get list of commands from eiscpData
		const eiscpData = eiscpDataAll.commands.main.SLI.values;
		// Create a JSON object for inputs from the eiscpData
		let newobj = '{ "Inputs" : [';
		let exkey;
		for (exkey in eiscpData) {
			let hold = eiscpData[exkey].name.toString();
			if (hold.includes(','))
				hold = hold.slice(0, hold.indexOf(','));
			if (exkey.includes('“') || exkey.includes('”')) {
				exkey = exkey.replace(/“/g, '');
				exkey = exkey.replace(/”/g, '');
			}

			if (exkey.includes('UP') || exkey.includes('DOWN') || exkey.includes('QSTN'))
				continue;

			// Work around specific bug for “26”
			if (exkey === '“26”')
				exkey = '26';

			if (exkey in eiscpData) {
				if ('models' in eiscpData[exkey])
					set = eiscpData[exkey].models;
				else
					continue;
			} else {
				continue;
			}

			if (inSets.includes(set))
				newobj = newobj + '{ "code":"' + exkey + '" , "label":"' + hold + '" },';
			else
				continue;
		}

		// Drop last comma first
		newobj = newobj.slice(0, -1) + ']}';
		RxInputs = JSON.parse(newobj);
	}

	polling(platform) {
		const that = platform;
	// Status Polling
		if (that.switchHandling === 'poll') {
			// somebody instroduced powerurl but we are never using it.
			// const powerurl = that.status_url;
			that.log.debug('start long poller..');
	// PWR Polling
			const statusemitter = pollingtoevent(done => {
				that.log.debug('start PWR polling..');
				that.getPowerState((error, response) => {
					// pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, 'statuspoll');
			}, {longpolling: true, interval: that.interval * 1000, longpollEventName: 'statuspoll'});

			statusemitter.on('statuspoll', data => {
				that.state = data;
				that.log.debug('event - PWR status poller - new state: ', that.state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.Active).updateValue(that.state, null, 'statuspoll');
				// }
			});
	// Audio-Input Polling
			const i_statusemitter = pollingtoevent(done => {
				that.log.debug('start INPUT polling..');
				that.getInputSource((error, response) => {
					// pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, 'i_statuspoll');
			}, {longpolling: true, interval: that.interval * 1000, longpollEventName: 'i_statuspoll'});

			i_statusemitter.on('i_statuspoll', data => {
				that.i_state = data;
				that.log.debug('event - INPUT status poller - new i_state: ', that.i_state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(that.i_state, null, 'i_statuspoll');
				// }
			});
	// Audio-Muting Polling
			const m_statusemitter = pollingtoevent(done => {
				that.log.debug('start MUTE polling..');
				that.getMuteState((error, response) => {
					// pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, 'm_statuspoll');
			}, {longpolling: true, interval: that.interval * 1000, longpollEventName: 'm_statuspoll'});

			m_statusemitter.on('m_statuspoll', data => {
				that.m_state = data;
				that.log.debug('event - MUTE status poller - new m_state: ', that.m_state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.Mute).updateValue(that.m_state, null, 'm_statuspoll');
				// }
			});
	// Volume Polling
			const v_statusemitter = pollingtoevent(done => {
				that.log.debug('start VOLUME polling..');
				that.getVolumeState((error, response) => {
					// pass also the setAttempt, to force a homekit update if needed
					done(error, response, that.setAttempt);
				}, 'v_statuspoll');
			}, {longpolling: true, interval: that.interval * 1000, longpollEventName: 'v_statuspoll'});

			v_statusemitter.on('v_statuspoll', data => {
				that.v_state = data;
				that.log.debug('event - VOLUME status poller - new v_state: ', that.v_state);
				// if (that.tvService ) {
				// 	that.tvService.getCharacteristic(Characteristic.Volume).updateValue(that.v_state, null, 'v_statuspoll');
				// }
			});
		}
	}

	/// ////////////////
	// EVENT FUNCTIONS
	/// ////////////////
	eventDebug(response) {
		this.log.debug('eventDebug: %s', response);
	}

	eventError(response) {
		this.log.error('eventError: %s', response);
	}

	eventConnect(response) {
		this.log.debug('eventConnect: %s', response);
		this.reachable = true;
	}

	eventSystemPower(response) {
		if (this.state !== (response === 'on'))
			this.log.info('Event - System Power changed: %s', response);

		this.state = (response === 'on');
		this.log.debug('eventSystemPower - message: %s, new state %s', response, this.state);
		// Communicate status
		if (this.tvService)
			this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state);
		// if (this.volume_dimmer) {
		// 	this.m_state = !(response == 'on');
		// 	this.dimmer.getCharacteristic(Characteristic.On).updateValue((response == 'on'), null, 'power event m_status');
		// }
	}

	eventAudioMuting(response) {
		this.m_state = (response === 'on');
		this.log.debug('eventAudioMuting - message: %s, new m_state %s', response, this.m_state);
		// Communicate status
		if (this.tvService)
			this.tvService.getCharacteristic(Characteristic.Mute).updateValue(this.m_state, null, 'm_statuspoll');
	}

	eventInput(response) {
		if (response) {
			let input = JSON.stringify(response);
			input = input.replace(/[[\]"]+/g, '');
			if (input.includes(','))
				input = input.slice(0, input.indexOf(','));

			// Convert to i_state input code
			const index
				= input !== null // eslint-disable-line no-negated-condition
				? RxInputs.Inputs.findIndex(i => i.label === input)
				: -1;
			if (this.i_state !== (index + 1))
				this.log.info('Event - Input changed: %s', input);

			this.i_state = index + 1;

			this.log.debug('eventInput - message: %s - new i_state: %s - input: %s', response, this.i_state, input);
			// this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.i_state);
		} else {
			// Then invalid Input chosen
			this.log.error('eventInput - ERROR - INVALID INPUT - Model does not support selected input.');
		}

		// Communicate status
		if (this.tvService)
			this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.i_state);
	}

	eventVolume(response) {
		if (this.mapVolume100) {
			const volumeMultiplier = this.maxVolume / 100;
			const newVolume = response / volumeMultiplier;
			this.v_state = Math.round(newVolume);
			this.log.debug('eventVolume - message: %s, new v_state %s PERCENT', response, this.v_state);
		} else {
			this.v_state = response;
			this.log.debug('eventVolume - message: %s, new v_state %s ACTUAL', response, this.v_state);
		}

		// Communicate status
		if (this.tvService)
			this.tvService.getCharacteristic(Characteristic.Volume).updateValue(this.v_state, null, 'v_statuspoll');
	}

	eventClose(response) {
		this.log.debug('eventClose: %s', response);
		this.reachable = false;
	}

	/// /////////////////////
	// GET AND SET FUNCTIONS
	/// /////////////////////
	setPowerState(powerOn, callback, context) {
	// if context is statuspoll, then we need to ensure that we do not set the actual value
		if (context && context === 'statuspoll') {
			this.log.debug('setPowerState - polling mode, ignore, state: %s', this.state);
			callback(null, this.state);
			return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		this.setAttempt++;

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		this.state = powerOn;
		callback(null, this.state);
		if (powerOn) {
			this.log.debug('setPowerState - actual mode, power state: %s, switching to ON', this.state);
			this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].power + '=on', (error, _) => {
				// this.log.debug( 'PWR ON: %s - %s -- current state: %s', error, response, this.state);
				if (error) {
					this.state = false;
					this.log.error('setPowerState - PWR ON: ERROR - current state: %s', this.state);
					// if (this.tvService ) {
					// 	this.tvService.getCharacteristic(Characteristic.Active).updateValue(powerOn, null, 'statuspoll');
					// }
				} else {
					// If the AVR has just been turned on, apply the default volume
						this.log.debug('Attempting to set the default volume to ' + this.defaultVolume);
						if (powerOn && this.defaultVolume) {
							this.log.info('Setting default volume to ' + this.defaultVolume);
							this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].volume + ':' + this.defaultVolume, function (error, _) {
								if (error)
									this.log.error('Error while setting default volume: %s', error);
							});
						}

					// If the AVR has just been turned on, apply the Input default
						this.log.debug('Attempting to set the default input selector to ' + this.defaultInput);

						// Handle defaultInput being either a custom label or manufacturer label
						let label = this.defaultInput;
						if (this.inputs) {
							this.inputs.forEach((input, _) => {
								if (input.input_name === this.default)
									label = input.input_name;
								else if (input.display_name === this.defaultInput)
									label = input.display_name;
							});
						}

						const index
							= label !== null // eslint-disable-line no-negated-condition
							? RxInputs.Inputs.findIndex(i => i.label === label)
							: -1;
						this.i_state = index + 1;

						if (powerOn && label) {
							this.log.info('Setting default input selector to ' + label);
							this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].input + '=' + label, function (error, _) {
								if (error)
									this.log.error('Error while setting default input: %s', error);
							});
						}
				}
			});
		} else {
			this.log.debug('setPowerState - actual mode, power state: %s, switching to OFF', this.state);
			this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].power + '=standby', (error, _) => {
				// this.log.debug( 'PWR OFF: %s - %s -- current state: %s', error, response, this.state);
				if (error) {
					this.state = false;
					this.log.error('setPowerState - PWR OFF: ERROR - current state: %s', this.state);
					// if (this.tvService ) {
					// 	this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state, null, 'statuspoll');
					// }
				}
			});
		}

		// if (this.volume_dimmer) {
		// 	this.m_state = !(powerOn == 'on');
		// 	this.dimmer.getCharacteristic(Characteristic.On).updateValue((powerOn == 'on'), null, 'power event m_status');
		// }
		this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state);
	}

	getPowerState(callback, context) {
		// if context is statuspoll, then we need to request the actual value
		if ((!context || context !== 'statuspoll') && this.switchHandling === 'poll') {
				this.log.debug('getPowerState - polling mode, return state: ', this.state);
				callback(null, this.state);
				return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, this.state);
		this.log.debug('getPowerState - actual mode, return state: ', this.state);
		this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].power + '=query', (error, _) => {
			if (error) {
				this.state = false;
				this.log.debug('getPowerState - PWR QRY: ERROR - current state: %s', this.state);
			}
		});
		this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.state);
	}

	getVolumeState(callback, context) {
		// if context is v_statuspoll, then we need to request the actual value
		if ((!context || context !== 'v_statuspoll') && this.switchHandling === 'poll') {
				this.log.debug('getVolumeState - polling mode, return v_state: ', this.v_state);
				callback(null, this.v_state);
				return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, this.v_state);
		this.log.debug('getVolumeState - actual mode, return v_state: ', this.v_state);
		this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].volume + '=query', (error, _) => {
			if (error) {
				this.v_state = 0;
				this.log.debug('getVolumeState - VOLUME QRY: ERROR - current v_state: %s', this.v_state);
			}
		});

		// Communicate status
		if (this.tvService)
			this.tvSpeakerService.getCharacteristic(Characteristic.Volume).updateValue(this.v_state);
	}

	setVolumeState(volumeLvl, callback, context) {
	// if context is v_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context === 'v_statuspoll') {
			this.log.debug('setVolumeState - polling mode, ignore, v_state: %s', this.v_state);
			callback(null, this.v_state);
			return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		this.setAttempt++;

		// Are we mapping volume to 100%?
		if (this.mapVolume100) {
			const volumeMultiplier = this.maxVolume / 100;
			const newVolume = volumeMultiplier * volumeLvl;
			this.v_state = Math.round(newVolume);
			this.log.debug('setVolumeState - actual mode, PERCENT, volume v_state: %s', this.v_state);
		} else if (volumeLvl > this.maxVolume) {
		// Determin if maxVolume threshold breached, if so set to max.
			this.v_state = this.maxVolume;
			this.log.debug('setVolumeState - VOLUME LEVEL of: %s exceeds maxVolume: %s. Resetting to max.', volumeLvl, this.maxVolume);
		} else {
		// Must be using actual volume number
			this.v_state = volumeLvl;
			this.log.debug('setVolumeState - actual mode, ACTUAL volume v_state: %s', this.v_state);
		}

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, this.v_state);

		this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].volume + ':' + this.v_state, (error, _) => {
			if (error) {
				this.v_state = 0;
				this.log.debug('setVolumeState - VOLUME : ERROR - current v_state: %s', this.v_state);
			}
		});

		// Communicate status
		if (this.tvService)
			this.tvSpeakerService.getCharacteristic(Characteristic.Volume).updateValue(this.v_state);
	}

	setVolumeRelative(volumeDirection, callback, context) {
	// if context is v_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context === 'v_statuspoll') {
			this.log.debug('setVolumeRelative - polling mode, ignore, v_state: %s', this.v_state);
			callback(null, this.v_state);
			return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		this.setAttempt++;

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, this.v_state);
		if (volumeDirection === Characteristic.VolumeSelector.INCREMENT) {
			this.log.debug('setVolumeRelative - VOLUME : level-up');
			this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].volume + ':level-up', (error, _) => {
				if (error) {
					this.v_state = 0;
					this.log.error('setVolumeRelative - VOLUME : ERROR - current v_state: %s', this.v_state);
				}
			});
		} else if (volumeDirection === Characteristic.VolumeSelector.DECREMENT) {
			this.log.debug('setVolumeRelative - VOLUME : level-down');
			this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].volume + ':level-down', (error, _) => {
				if (error) {
					this.v_state = 0;
					this.log.error('setVolumeRelative - VOLUME : ERROR - current v_state: %s', this.v_state);
				}
			});
		} else {
			this.log.error('setVolumeRelative - VOLUME : ERROR - unknown direction sent');
		}

		// Communicate status
		if (this.tvService)
			this.tvSpeakerService.getCharacteristic(Characteristic.Volume).updateValue(this.v_state);
	}

	getMuteState(callback, context) {
		// if context is m_statuspoll, then we need to request the actual value
		if ((!context || context !== 'm_statuspoll') && this.switchHandling === 'poll') {
				this.log.debug('getMuteState - polling mode, return m_state: ', this.m_state);
				callback(null, this.m_state);
				return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, this.m_state);
		this.log.debug('getMuteState - actual mode, return m_state: ', this.m_state);
		this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].muting + '=query', (error, _) => {
			if (error) {
				this.m_state = false;
				this.log.debug('getMuteState - MUTE QRY: ERROR - current m_state: %s', this.m_state);
			}
		});

		// Communicate status
		if (this.tvService)
			this.tvSpeakerService.getCharacteristic(Characteristic.Mute).updateValue(this.m_state);
	}

	setMuteState(muteOn, callback, context) {
	// if context is m_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context === 'm_statuspoll') {
			this.log.debug('setMuteState - polling mode, ignore, m_state: %s', this.m_state);
			callback(null, this.m_state);
			return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		this.setAttempt++;

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		this.m_state = muteOn;
		callback(null, this.m_state);
		if (this.m_state) {
			this.log.debug('setMuteState - actual mode, mute m_state: %s, switching to ON', this.m_state);
			this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].muting + '=on', (error, _) => {
				if (error) {
					this.m_state = false;
					this.log.error('setMuteState - MUTE ON: ERROR - current m_state: %s', this.m_state);
				}
			});
		} else {
			this.log.debug('setMuteState - actual mode, mute m_state: %s, switching to OFF', this.m_state);
			this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].muting + '=off', (error, _) => {
				if (error) {
					this.m_state = false;
					this.log.error('setMuteState - MUTE OFF: ERROR - current m_state: %s', this.m_state);
				}
			});
		}

		// Communicate status
		if (this.tvService)
			this.tvSpeakerService.getCharacteristic(Characteristic.Mute).updateValue(this.m_state);
	}

	getInputSource(callback, context) {
		// if context is i_statuspoll, then we need to request the actual value
		if ((!context || context !== 'i_statuspoll') && this.switchHandling === 'poll') {
				this.log.debug('getInputState - polling mode, return i_state: ', this.i_state);
				callback(null, this.i_state);
				return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		// do the callback immediately, to free homekit
		// have the event later on execute changes

		this.log.debug('getInputState - actual mode, return i_state: ', this.i_state);
		this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].input + '=query', (error, _) => {
			if (error) {
				this.i_state = 1;
				this.log.error('getInputState - INPUT QRY: ERROR - current i_state: %s', this.i_state);
			}
		});
		callback(null, this.i_state);
		// Communicate status
		if (this.tvService)
			this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.i_state);
	}

	setInputSource(source, callback, context) {
	// if context is i_statuspoll, then we need to ensure this we do not set the actual value
		if (context && context === 'i_statuspoll') {
			this.log.info('setInputState - polling mode, ignore, i_state: %s', this.i_state);
			callback(null, this.i_state);
			return;
		}

		if (!this.ip_address) {
			this.log.error('Ignoring request; No ip_address defined.');
			callback(new Error('No ip_address defined.'));
			return;
		}

		this.setAttempt++;

		this.i_state = source;
		const label = RxInputs.Inputs[this.i_state - 1].label;

		this.log.debug('setInputState - actual mode, ACTUAL input i_state: %s - label: %s', this.i_state, label);

		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, this.i_state);
		this.eiscp.command(this.zone + '.' + this.cmdMap[this.zone].input + ':' + label, (error, _) => {
			if (error)
				this.log.error('setInputState - INPUT : ERROR - current i_state:%s - Source:%s', this.i_state, source.toString());
		});

		// Communicate status
		if (this.tvService)
			this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.i_state);
	}

	remoteKeyPress(button, callback) {
		// do the callback immediately, to free homekit
		// have the event later on execute changes
		callback(null, button);
		if (this.buttons[button]) {
			const press = this.buttons[button];
			this.log.debug('remoteKeyPress - INPUT: pressing key %s', press);
			this.eiscp.command(this.zone + '.setup=' + press, (error, _) => {
				if (error) {
					// this.i_state = 1;
					this.log.error('remoteKeyPress - INPUT: ERROR pressing button %s', press);
				}
			});
		} else {
			this.log.error('Remote button %d not supported.', button);
		}
	}

	identify(callback) {
		this.log.info('Identify requested! %s', this.ip_address);
		callback(); // success
	}

	/// /////////////////////
	// TV SERVICE FUNCTIONS
	/// /////////////////////
	addSources(service) {
		// If input name mappings are provided, use them.
		// Option to only configure specified inputs with filter_inputs
		if (this.filter_inputs) {
			// Check the RxInputs.Inputs items to see if each exists in this.inputs. Return new array of those that do.
			RxInputs.Inputs = RxInputs.Inputs.filter(rxinput => {
				return this.inputs.some(input => {
					return input.input_name === rxinput.label;
				});
			});
		}

		this.log.debug(RxInputs.Inputs);
		// Create final array of inputs, using any labels defined in the config's inputs to override the default labels
		const inputs = RxInputs.Inputs.map((i, index) => {
			const hapId = index + 1;
			let inputName = i.label;
			if (this.inputs) {
				this.inputs.forEach((input, _) => {
					if (input.input_name === i.label)
						inputName = input.display_name;
				});
			}

			const input = this.setupInput(i.code, inputName, hapId, service);
			return input;
		});
		return inputs;
	}

	setupInput(inputCode, name, hapId, television) {
		const input = this.accessory.addService(Service.InputSource, `${this.name} ${name}`, inputCode);
		const inputSourceType = Characteristic.InputSourceType.HDMI;

		input
			.setCharacteristic(Characteristic.Identifier, hapId)
			.setCharacteristic(Characteristic.ConfiguredName, name)
			.setCharacteristic(
			Characteristic.IsConfigured,
			Characteristic.IsConfigured.CONFIGURED,
			)
			.setCharacteristic(Characteristic.InputSourceType, inputSourceType);

		input.getCharacteristic(Characteristic.ConfiguredName).setProps({
			perms: [Characteristic.Perms.READ],
		});

		television.addLinkedService(input);
		return input;
	}

	createAccessoryInformationService(accessory) {
		let informationService = accessory.getService(Service.AccessoryInformation);
		if (!informationService)
			informationService = accessory.addService(Service.AccessoryInformation);

		informationService
			.setCharacteristic(Characteristic.Manufacturer, this.avrManufacturer)
			.setCharacteristic(Characteristic.Model, this.model)
			.setCharacteristic(Characteristic.SerialNumber, this.avrSerial)
			.setCharacteristic(Characteristic.FirmwareRevision, info.version)
			.setCharacteristic(Characteristic.Name, this.name);

		return informationService;
	}

	createVolumeType(service) {
		if (this.volume_type === 'dimmer') {
			this.dimmer = this.accessory.addService(Service.Lightbulb, this.name + ' Volume', 'dimmer');
			this.dimmer
			.getCharacteristic(Characteristic.On)
			// Inverted logic taken from https://github.com/langovoi/homebridge-upnp
			.on('get', callback => {
				this.getMuteState((error, value) => {
					if (error) {
						callback(error);
						return;
					}

					callback(null, !value);
				});
			})
			.on('set', (value, callback) => this.setMuteState(!value, callback));
			this.dimmer
			.addCharacteristic(Characteristic.Brightness)
			.on('get', this.getVolumeState.bind(this))
			.on('set', this.setVolumeState.bind(this));

		service.addLinkedService(this.dimmer);
		} else if (this.volume_type === 'speed') {
			this.speed = this.accessory.addService(Service.Fan, this.name + ' Volume', 'speed');
			this.speed
			.getCharacteristic(Characteristic.On)
			// Inverted logic taken from https://github.com/langovoi/homebridge-upnp
			.on('get', callback => {
				this.getMuteState((error, value) => {
					if (error) {
						callback(error);
						return;
					}

					callback(null, !value);
				});
			})
			.on('set', (value, callback) => this.setMuteState(!value, callback));
			this.speed
			.addCharacteristic(Characteristic.RotationSpeed)
			.on('get', this.getVolumeState.bind(this))
			.on('set', this.setVolumeState.bind(this));

		service.addLinkedService(this.speed);
		}
	}

	createTvService(accessory) {
		this.log.debug('Creating TV service for receiver %s', this.name);
		const tvService = accessory.addService(Service.Television, this.name);

		tvService
			.getCharacteristic(Characteristic.ConfiguredName)
			.setValue(this.name)
			.setProps({
				perms: [Characteristic.Perms.READ],
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
		this.tvSpeakerService = this.accessory.addService(Service.TelevisionSpeaker, this.name + ' Volume', 'tvSpeakerService');
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
	}
}

module.exports = homebridge => {
  ({Service, Characteristic} = homebridge.hap);
  homebridge.registerPlatform('homebridge-onkyo', 'Onkyo', OnkyoPlatform);
};
