import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import {
    convertFreezerTemperature,
    convertFridgeTemperature,
    freezerRange,
    fridgeRange,
    TemperatureUnit,
} from './fridge_common'

const FLEX_OPTIONS = ['Chilled Wine', 'Deli/Snacks', 'Cold Drink', 'Meat/Seafood', 'Freezer']

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined
    lastStatSequence: number = -1
    lastEnergySequence: number = -1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })

        // HomeAssistant configuration will be ready once we find out the temperature unit
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
        // set or re-set the temperature unit
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...fridgeRange(unit),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange(unit),
                    },
                    flex_setpoint: {
                        platform: 'select',
                        //device_class: "temperature",
                        icon: 'mdi:thermometer',
                        unique_id: '$deviceid-flex_setpoint',
                        state_topic: '$this/flex_setpoint',
                        command_topic: '$this/flex_setpoint/set',
                        name: 'Convertible',
                        options: FLEX_OPTIONS,
                    },
                    express_freeze: {
                        platform: 'switch',
                        icon: 'mdi:snowflake-alert',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Express Freeze',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    energy_consumption_delta: {
                        platform: 'sensor',
                        state_class: 'measurement',
                        unique_id: '$deviceid-energy_consumption_delta',
                        state_topic: '$this/energy_consumption_delta',
                        name: 'Energy Consumption (15m)',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:flash',
                    },
                    energy_consumption: {
                        platform: 'sensor',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unique_id: '$deviceid-energy_consumption',
                        state_topic: '$this/energy_consumption',
                        name: 'Energy Consumption',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:flash',
                    },
                    fridge_door_opens_delta: {
                        platform: 'sensor',
                        state_class: 'measurement',
                        unique_id: '$deviceid-fridge_door_opens_delta',
                        state_topic: '$this/fridge_door_opens_delta',
                        name: 'Fridge Door Opens (15m)',
                        icon: 'mdi:door-open',
                    },
                    fridge_door_opens: {
                        platform: 'sensor',
                        state_class: 'total_increasing',
                        unique_id: '$deviceid-fridge_door_opens',
                        state_topic: '$this/fridge_door_opens',
                        name: 'Fridge Door Opens',
                        icon: 'mdi:door-open',
                    },
                    freezer_door_opens_delta: {
                        platform: 'sensor',
                        state_class: 'measurement',
                        unique_id: '$deviceid-freezer_door_opens_delta',
                        state_topic: '$this/freezer_door_opens_delta',
                        name: 'Freezer Door Opens (15m)',
                        icon: 'mdi:door-open',
                    },
                    freezer_door_opens: {
                        platform: 'sensor',
                        state_class: 'total_increasing',
                        unique_id: '$deviceid-freezer_door_opens',
                        state_topic: '$this/freezer_door_opens',
                        name: 'Freezer Door Opens',
                        icon: 'mdi:door-open',
                    },
                    fridge_door_duration_delta: {
                        platform: 'sensor',
                        state_class: 'measurement',
                        unique_id: '$deviceid-fridge_door_duration_delta',
                        state_topic: '$this/fridge_door_duration_delta',
                        name: 'Fridge Door Open Duration (15m)',
                        unit_of_measurement: 's',
                        icon: 'mdi:timer',
                    },
                    freezer_door_duration_delta: {
                        platform: 'sensor',
                        state_class: 'measurement',
                        unique_id: '$deviceid-freezer_door_duration_delta',
                        state_topic: '$this/freezer_door_duration_delta',
                        name: 'Freezer Door Open Duration (15m)',
                        unit_of_measurement: 's',
                        icon: 'mdi:timer',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // I'm not sure what is the proper way to identify packet types, so let's match
        // on the length and a few initial bytes

        if (buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC (prev status) (cur status)
            const blockLen = (buf.length - 2) / 2
            this.processStatus(buf.subarray(2 + blockLen, 2 + blockLen + blockLen))
        }

        if (buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB (initial status)
            const blockLen = buf.length - 2
            this.processStatus(buf.subarray(2, 2 + blockLen))
        }

        if (buf[0] == 0x10 && buf[1] == 0xc5) {
            // 10C5 (energy & statistics)
            this.processStatistics(buf)
        }

        if (buf[0] == 0x10 && buf[1] == 0x3e) {
            // 103E (energy usage)
            this.processEnergyUsage(buf)
        }
    }

    processStatus(curStatus: Buffer) {
        // status block example:
        // 0209060202020400000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000101FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000
        const unit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const setpointFridge = convertFridgeTemperature(unit, curStatus[1])
        const setpointFreezer = convertFreezerTemperature(unit, curStatus[2])
        const icePlus = curStatus[3] // 1=off 2=on
        const smartGrid = curStatus[5] // 0=off 1=? 2=on
        const anyDoorOpen = curStatus[7]
        const panelLock = curStatus[10] // 2=locked 1=unlocked
        const setpointFlex = curStatus[13] // 1 - chilled wine. 2 - deli/snacks. 3 - cold drink. 4 - meat/seafood. 5 - freezer
        const iceDoor = curStatus[32] // 0=off 1=on 2=full
        const iceCube = curStatus[33] // 0=off 1=on 2=full

        this.publishProperty('door', anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
        this.publishProperty('flex_setpoint', FLEX_OPTIONS[setpointFlex - 1])
        this.publishProperty('express_freeze', icePlus === 2 ? 'ON' : 'OFF')
    }

    processEnergyUsage(buf: Buffer) {
        if (buf.length < 7) return

        const sequence = buf[6]
        if (sequence === this.lastEnergySequence) {
            // Deduplicate burst packets sent within the same 15-minute interval
            return
        }
        this.lastEnergySequence = sequence

        // 10 3E [0~1: 15-min usage] [2~3: 16-bit cumulative counter] [4: sequence]
        // In buf payload (where buf[0] is 0x10, buf[1] is 0x3E):
        // buf[2~3] = 15-min usage delta
        // buf[4~5] = 16-bit cumulative counter
        const energyDelta = buf.readUInt16BE(2)
        const energyAccum = buf.readUInt16BE(4)

        this.publishProperty('energy_consumption_delta', energyDelta.toString())
        this.publishProperty('energy_consumption', energyAccum.toString())
    }

    processStatistics(buf: Buffer) {
        if (buf.length < 28) return

        const sequence = buf[2]
        if (sequence === this.lastStatSequence) {
            // Deduplicate burst packets sent within the same 15-minute interval
            return
        }
        this.lastStatSequence = sequence

        // Marker 0x04: Fridge Stats
        if (buf[3] === 0x04) {
            const fridgeDelta = buf.readUInt16BE(5)
            const fridgeAccum = buf.readUIntBE(7, 3)
            this.publishProperty('fridge_door_opens_delta', fridgeDelta.toString())
            this.publishProperty('fridge_door_opens', fridgeAccum.toString())
        }

        // Marker 0x03: Freezer Stats
        if (buf[10] === 0x03) {
            const freezerDelta = buf.readUInt16BE(11)
            const freezerAccum = buf.readUIntBE(13, 3)
            this.publishProperty('freezer_door_opens_delta', freezerDelta.toString())
            this.publishProperty('freezer_door_opens', freezerAccum.toString())
        }

        // Marker 0x11: Unknown (previously thought to be Energy)
        /*
        if (buf[16] === 0x11) {
            const energyDelta = buf.readUInt16BE(17)
            const energyAccum = buf.readUIntBE(19, 3)
            this.publishProperty('energy_consumption_delta', energyDelta.toString())
            this.publishProperty('energy_consumption', energyAccum.toString())
        }
        */

        // Marker 0x13: Door Open Durations (Delta)
        if (buf[22] === 0x13) {
            const fridgeDurationDelta = buf.readUInt16BE(23)
            const freezerDurationDelta = buf.readUInt16BE(26)
            this.publishProperty('fridge_door_duration_delta', fridgeDurationDelta.toString())
            this.publishProperty('freezer_door_duration_delta', freezerDurationDelta.toString())
        }
    }

    //  0                   1                   2                   3                   4                   5                   6                   7                   8                   9                  10
    //  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4
    // express freeze off
    // AA69F017FFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBCBB
    // fridge 38F
    // AA69F017FF06FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBABB
    // fridge 36F
    // AA69F017FF08FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA4BB
    // freezer -7F
    // AA69F017FFFF0DFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA3BB
    // freezer +5F
    // AA69F017FFFF01FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB
    // convertible freezer
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF05FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBBBB
    // convertible wine=41
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF01FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB
    // convertible deli=37
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF02FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB
    // convertible meat/seafood=30
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF04FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFB8BB
    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'C'
        const baseMessage = Buffer.from(
            'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
            'hex',
        )
        baseMessage[2 + 8] = unit === 'C' ? 1 : 0

        if (prop === 'fridge_setpoint') {
            baseMessage[2 + 1] = convertFridgeTemperature(unit, Number(mqttValue))
            this.send(baseMessage)
        } else if (prop === 'freezer_setpoint') {
            baseMessage[2 + 2] = convertFreezerTemperature(unit, Number(mqttValue))
            this.send(baseMessage)
        } else if (prop === 'flex_setpoint') {
            const index = FLEX_OPTIONS.indexOf(mqttValue)
            if (index < 0) console.warn(`Unexpected value ${mqttValue}`)
            else {
                baseMessage[2 + 13] = 1 + index
                this.send(baseMessage)
            }
        } else if (prop === 'express_freeze') {
            baseMessage[2 + 3] = mqttValue === 'ON' ? 2 : 1
            this.send(baseMessage)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
