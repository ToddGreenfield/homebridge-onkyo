# homebridge-onkyo
[![NPM Version](https://img.shields.io/npm/v/homebridge-onkyo.svg)](https://www.npmjs.com/package/homebridge-onkyo)

Homebridge plugin for Onkyo Receivers
Should work for all supported models as listed in the node_modules/eiscp/eiscp-commands.json. If your model is not listed, try TX-NR609.

# Description

This is an enhanced fork from the original/unmaintained homebridge-onkyo-avr plugin written by gw-wiscon.
Existing users of my original fork or gw-wiscon's be sure to update the "platform" config to "Onkyo".

# Changelog

* Verison 0.7 iOS 12.2+ is now required. This is now a Platform, theoretically supporting multiple receivers. Each receiver is a TV accessory (which is why iOS 12.2+ is required). Input labels can customized with `inputs` in the config. An optional Dimmer service for separate volume control is available, useful for non-iPhone control and more advanced automations (it appears as a dimmable light bulb). To disable the volume dimmer, add `"volume_dimmer": false` to your receiver in config.
* Version 0.6 includes support for zone2. Adds a new config parameter called "zone" and use "zone2". Thanks for the contrib mbbeaubi.
* Version 0.5.x includes support for input-selector. Available inputs are dynamically pulled from the eiscp-commands.json file. Note: Not all inputs may work with your receiver.
* Version 0.4.x includes support for volume, mute, and has options for setting default_input.

For Siri Control of Volume, Mute, and Input - Use an app like EVE which has control sliders and create scenes for "Volume Mute" or "Volume Unmute", and/or various volume level scenes like "Volume Low" or "Volume Loud", or for inputs like "input network" or "input fm". It may be easiest to set the volume or Input first using the OnkyoRemote3 app and then creating the scenes so the volume or input is pre-set (without using the slider).

For Alexa Control of Volume, Mute, Input - (if using the Alexa plugin) - create DummySwitches (homebridge-dummy) and setup an automation to run the scene created from above. "Alexa, turn on Volume Loud."

# To Do

Complete re-write to convert to a Platform. This will allow for auto discovery of all receivers (if more than one exist), and other flexibility.
Adding Speaker A/B on/off control
Others...

# Installation

Ensure that the Onkyo receiver is controllable using the OnkyoRemote3 iOS app.
For Troubleshooting look in the homebridge-onkyo/node_modules/eiscp/examples directory and see if you can run 3.js. "node 3.js". It should output all available commands.

1. Install homebridge using: npm install -g homebridge
2. Install this plugin using: npm install -g homebridge-onkyo
3. Update your configuration file. See the sample below.

# Configuration

Example accessory config (needs to be added to the homebridge config.json):
 ```
"platforms": [{
        "platform": "Onkyo",
        "receivers": [
            {
                "model": "TX-NR609",
                "ip_address": "10.0.0.46",
                "poll_status_interval": "3000",
                "name": "Receiver",
                "inputs": {
                    "dvd": "Blu-ray",
                    "video2": "Switch",
                    "video3": "Wii U",
                    "video6": "Apple TV",
                    "video4": "AUX",
                    "cd": "TV/CD"
                },
                "volume_dimmer": false,
                "switch_service": false,
                "filter_inputs": true
            }
        ]
    }]
 ```
### Config Explanation:

Field           			| Description
----------------------------|------------
**platform**   			| (required) Must always be "Onkyo".
**receivers**               | (required) List of receiver accessories to create. Must contain at least 1.
Receiver Attributes         |
----------------------------|------------
**name**					| (required) The name you want to use for control of the Onkyo accessories.
**ip_address**  			| (required) The internal ip address of your Onkyo.
**model**					| (required) Must be a valid model listed in node_modules/eiscp/eiscp-commands.json file. If your model is not listed, you can use the TX-NR609 if your model supports the Integra Serial Communication Protocol (ISCP).
**poll_status_interval**  	| (optional) Poll Status Interval. Defaults to 0 or no polling.
**default_input**  			| (optional) A valid source input. Default will use last known input. See output of 3.js in eiscp/examples for options.
**default_volume**  		| (optional) Initial receiver volume upon powerup. This is the true volume number, not a percentage. Ignored if powerup from device knob or external app (like OnkyoRemote3).
**max_volume**  			| (optional) Receiver volume max setting. This is a true volume number, not a percentage, and intended so there is not accidental setting of volume to 80. Ignored by external apps (like OnkyoRemote3). Defaults to 30.
**map_volume_100**  		| (optional) Will remap the volume percentages that appear in the Home app so that the configured max_volume will appear as 100% in the Home app. For example, if the max_volume is 30, then setting the volume slider to 50% would set the receiver's actual volume to 15. Adjusting the stereo volume knob to 35 will appear as 100% in the Home app. This option could confuse some users to it defaults to off false, but it does give the user finer volume control especially when sliding volume up and down in the Home app. Defaults to False.
**zone**              		| (optional) Defaults to main. Optionally control zone2 where supported.
**inputs**					| (optional) List of inputs you want populated for the TV service and what you want them to be labeled. Inputs not listed are omitted.
**filter_inputs**                   | (optional) Boolean value. Setting this to `true` limits inputs displayed in HomeKit to those you provide in `inputs`. If `false` or not defined, all inputs supported by `model` will be displayed.
**volume_dimmer**					| (optional) Boolean value. Setting this to `false` disables additional Dimmer accessory for separate volume control.
