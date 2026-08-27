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
export const NIGHT_GLARE_OPTIONS = ['Off', 'Sunset/Sunrise', 'Custom'] as const
type NightGlareMode = (typeof NIGHT_GLARE_OPTIONS)[number]

const NIGHT_GLARE_COMMAND_MODE: Record<NightGlareMode, number> = {
    Off: 0x00,
    'Sunset/Sunrise': 0x01,
    Custom: 0x02,
}

const NIGHT_GLARE_STATUS_MODE: Record<number, NightGlareMode> = {
    0x00: 'Off',
    0x02: 'Sunset/Sunrise',
    0x03: 'Custom',
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const F017_BASE =
    'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
const SMART_CARE_BASE =
    'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'

export function buildF017Message(unit: TemperatureUnit): Buffer {
    const message = Buffer.from(F017_BASE, 'hex')
    message[2 + 8] = unit === 'C' ? 1 : 0
    return message
}

export function buildSmartCareCommands(enabled: boolean): Buffer[] {
    // Smart Care+ uses the 120-byte F017 shape captured from ThinQ, not the
    // legacy 101-byte F017 shape used for temperature and Express Freeze.
    const smartCareMessage = Buffer.from(SMART_CARE_BASE, 'hex')
    smartCareMessage[2 + 17] = enabled ? 1 : 0
    if (enabled) return [smartCareMessage]

    const restoreFreshAirMessage = Buffer.from(SMART_CARE_BASE, 'hex')
    restoreFreshAirMessage[2 + 17] = 0xff
    restoreFreshAirMessage[2 + 4] = 0x06
    return [smartCareMessage, restoreFreshAirMessage]
}

function parseTime(value: string): { hours: number; minutes: number } | undefined {
    const match = /^(\d{2}):(\d{2})$/.exec(value)
    if (!match) return undefined

    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) return undefined
    return { hours, minutes }
}

function writeKstTimeAsUtc(target: Buffer, offset: number, kstDate: Date) {
    const utc = new Date(kstDate.getTime() - KST_OFFSET_MS)
    target[offset] = utc.getUTCFullYear() % 100
    target[offset + 1] = utc.getUTCMonth() + 1
    target[offset + 2] = utc.getUTCDate()
    target[offset + 3] = utc.getUTCHours()
    target[offset + 4] = utc.getUTCMinutes()
    target[offset + 5] = utc.getUTCSeconds()
}

export function buildNightGlareCommand(
    mode: NightGlareMode,
    start: string,
    end: string,
    brightness: number,
    now: Date = new Date(),
): Buffer {
    if (!NIGHT_GLARE_OPTIONS.includes(mode)) throw new Error(`Invalid night glare mode: ${mode}`)
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100)
        throw new Error(`Invalid night glare brightness: ${brightness}`)

    const command = Buffer.alloc(18)
    command[0] = 0xf0
    command[1] = 0x10
    command[2] = 0x02
    command[3] = NIGHT_GLARE_COMMAND_MODE[mode]
    command[17] = brightness

    if (mode === 'Off') return command

    const parsedStart = parseTime(start)
    const parsedEnd = parseTime(end)
    if (!parsedStart || !parsedEnd) throw new Error(`Invalid night glare schedule: ${start}-${end}`)

    // Shift now into KST, then use UTC accessors as timezone-independent KST calendar fields.
    const kstNow = new Date(now.getTime() + KST_OFFSET_MS)
    const startKst = new Date(
        Date.UTC(
            kstNow.getUTCFullYear(),
            kstNow.getUTCMonth(),
            kstNow.getUTCDate(),
            parsedStart.hours,
            parsedStart.minutes,
        ),
    )
    const endKst = new Date(
        Date.UTC(
            kstNow.getUTCFullYear(),
            kstNow.getUTCMonth(),
            kstNow.getUTCDate(),
            parsedEnd.hours,
            parsedEnd.minutes,
        ),
    )
    if (endKst.getTime() <= startKst.getTime()) endKst.setUTCDate(endKst.getUTCDate() + 1)

    writeKstTimeAsUtc(command, 4, startKst)
    writeKstTimeAsUtc(command, 10, endKst)
    return command
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined
    lastStatSequence: number = -1
    lastEnergySequence: number = -1
    nightGlareMode: NightGlareMode = 'Off'
    nightGlareStart = '21:00'
    nightGlareEnd = '06:00'
    nightGlareBrightness = 30

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
                    smart_care: {
                        platform: 'switch',
                        icon: 'mdi:shield-check',
                        unique_id: '$deviceid-smart_care',
                        state_topic: '$this/smart_care',
                        command_topic: '$this/smart_care/set',
                        name: 'Smart Care+',
                    },
                    night_glare_mode: {
                        platform: 'select',
                        icon: 'mdi:theme-light-dark',
                        unique_id: '$deviceid-night_glare_mode',
                        state_topic: '$this/night_glare_mode',
                        command_topic: '$this/night_glare_mode/set',
                        name: 'Night Glare Mode',
                        options: NIGHT_GLARE_OPTIONS,
                    },
                    night_glare_start: {
                        platform: 'text',
                        icon: 'mdi:clock-start',
                        unique_id: '$deviceid-night_glare_start',
                        state_topic: '$this/night_glare_start',
                        command_topic: '$this/night_glare_start/set',
                        name: 'Night Glare Start',
                        pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
                    },
                    night_glare_end: {
                        platform: 'text',
                        icon: 'mdi:clock-end',
                        unique_id: '$deviceid-night_glare_end',
                        state_topic: '$this/night_glare_end',
                        command_topic: '$this/night_glare_end/set',
                        name: 'Night Glare End',
                        pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
                    },
                    night_glare_brightness: {
                        platform: 'number',
                        icon: 'mdi:brightness-percent',
                        unique_id: '$deviceid-night_glare_brightness',
                        state_topic: '$this/night_glare_brightness',
                        command_topic: '$this/night_glare_brightness/set',
                        name: 'Night Glare Brightness',
                        unit_of_measurement: '%',
                        min: 0,
                        max: 100,
                        step: 10,
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

                    freezer_door_opens_delta: {
                        platform: 'sensor',
                        state_class: 'measurement',
                        unique_id: '$deviceid-freezer_door_opens_delta',
                        state_topic: '$this/freezer_door_opens_delta',
                        name: 'Freezer Door Opens (15m)',
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
        this.publishProperty('night_glare_start', this.nightGlareStart)
        this.publishProperty('night_glare_end', this.nightGlareEnd)
        this.publishProperty('night_glare_brightness', this.nightGlareBrightness)
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
        if (curStatus.length < 34) {
            console.warn(`Unexpected refrigerator status length: ${curStatus.length}`)
            return
        }

        const unit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const setpointFridge = convertFridgeTemperature(unit, curStatus[1])
        const setpointFreezer = convertFreezerTemperature(unit, curStatus[2])
        const icePlus = curStatus[3] // 1=off 2=on
        const smartGrid = curStatus[5] // 0=off 1=? 2=on
        const anyDoorOpen = curStatus[7]
        const panelLock = curStatus[10] // 2=locked 1=unlocked
        const setpointFlex = curStatus[13] // 1 - chilled wine. 2 - deli/snacks. 3 - cold drink. 4 - meat/seafood. 5 - freezer
        const smartCare = curStatus[17]
        const nightGlareStatus = curStatus[30]
        const iceDoor = curStatus[32] // 0=off 1=on 2=full
        const iceCube = curStatus[33] // 0=off 1=on 2=full

        this.publishProperty('door', anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
        this.publishProperty('flex_setpoint', FLEX_OPTIONS[setpointFlex - 1])
        this.publishProperty('express_freeze', icePlus === 2 ? 'ON' : 'OFF')
        if (smartCare === 0 || smartCare === 1) this.publishProperty('smart_care', smartCare === 1 ? 'ON' : 'OFF')
        else console.warn(`Unexpected Smart Care+ status: ${smartCare}`)

        const nightGlareMode = NIGHT_GLARE_STATUS_MODE[nightGlareStatus]
        if (nightGlareMode) {
            this.nightGlareMode = nightGlareMode
            this.publishProperty('night_glare_mode', nightGlareMode)
        } else {
            console.warn(`Unexpected night glare status: ${nightGlareStatus}`)
        }
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

        // 10C5 packets contain data blocks identified by the second byte in each sequence.
        // ID 0x01: Fridge Door Opens (Delta: buf[5~6])
        if (buf[4] === 0x01) {
            const fridgeDelta = buf.readUInt16BE(5)
            this.publishProperty('fridge_door_opens_delta', fridgeDelta.toString())
            // Accumulator: buf[7~9]
        }

        // ID 0x03: Freezer Door Opens (Delta: buf[11~12])
        if (buf[10] === 0x03) {
            const freezerDelta = buf.readUInt16BE(11)
            this.publishProperty('freezer_door_opens_delta', freezerDelta.toString())
            // Accumulator: buf[13~15]
        }

        // ID 0x11: Fridge Door Duration (Delta: buf[17~18])
        if (buf[16] === 0x11) {
            const fridgeDurationDelta = buf.readUInt16BE(17)
            this.publishProperty('fridge_door_duration_delta', fridgeDurationDelta.toString())
            // Accumulator: buf[19~21]
        }

        // ID 0x13: Freezer Door Duration (Delta: buf[23~24])
        if (buf[22] === 0x13) {
            const freezerDurationDelta = buf.readUInt16BE(23)
            this.publishProperty('freezer_door_duration_delta', freezerDurationDelta.toString())
            // Accumulator: buf[25~27]
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
        if (prop === 'fridge_setpoint') {
            const baseMessage = buildF017Message(unit)
            baseMessage[2 + 1] = convertFridgeTemperature(unit, Number(mqttValue))
            this.send(baseMessage)
        } else if (prop === 'freezer_setpoint') {
            const baseMessage = buildF017Message(unit)
            baseMessage[2 + 2] = convertFreezerTemperature(unit, Number(mqttValue))
            this.send(baseMessage)
        } else if (prop === 'flex_setpoint') {
            const index = FLEX_OPTIONS.indexOf(mqttValue)
            if (index < 0) console.warn(`Unexpected value ${mqttValue}`)
            else {
                const baseMessage = buildF017Message(unit)
                baseMessage[2 + 13] = 1 + index
                this.send(baseMessage)
            }
        } else if (prop === 'express_freeze') {
            if (mqttValue !== 'ON' && mqttValue !== 'OFF') {
                console.warn(`Unexpected express freeze value ${mqttValue}`)
                return
            }
            const baseMessage = buildF017Message(unit)
            baseMessage[2 + 3] = mqttValue === 'ON' ? 2 : 1
            this.send(baseMessage)
        } else if (prop === 'smart_care') {
            if (mqttValue !== 'ON' && mqttValue !== 'OFF') {
                console.warn(`Unexpected Smart Care+ value ${mqttValue}`)
                return
            }

            for (const command of buildSmartCareCommands(mqttValue === 'ON')) this.send(command)
        } else if (prop === 'night_glare_mode') {
            if (!NIGHT_GLARE_OPTIONS.includes(mqttValue as NightGlareMode)) {
                console.warn(`Unexpected night glare mode ${mqttValue}`)
                return
            }
            const mode = mqttValue as NightGlareMode
            this.sendNightGlareSetting(mode)
        } else if (prop === 'night_glare_start') {
            if (!parseTime(mqttValue)) {
                console.warn(`Unexpected night glare start time ${mqttValue}`)
                return
            }
            this.nightGlareStart = mqttValue
            this.publishProperty('night_glare_start', mqttValue)
            if (this.nightGlareMode !== 'Off') this.sendNightGlareSetting(this.nightGlareMode)
        } else if (prop === 'night_glare_end') {
            if (!parseTime(mqttValue)) {
                console.warn(`Unexpected night glare end time ${mqttValue}`)
                return
            }
            this.nightGlareEnd = mqttValue
            this.publishProperty('night_glare_end', mqttValue)
            if (this.nightGlareMode !== 'Off') this.sendNightGlareSetting(this.nightGlareMode)
        } else if (prop === 'night_glare_brightness') {
            const brightness = Number(mqttValue)
            if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
                console.warn(`Unexpected night glare brightness ${mqttValue}`)
                return
            }
            this.nightGlareBrightness = brightness
            this.publishProperty('night_glare_brightness', brightness)
            this.sendNightGlareSetting(this.nightGlareMode)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }

    sendNightGlareSetting(mode: NightGlareMode) {
        try {
            const command = buildNightGlareCommand(
                mode,
                this.nightGlareStart,
                this.nightGlareEnd,
                this.nightGlareBrightness,
            )
            this.send(command)
            // Use the requested mode for subsequent local setting writes, but wait for a
            // 10EB/10EC report before publishing the mode back to Home Assistant.
            this.nightGlareMode = mode
        } catch (err) {
            console.warn(`Unable to build night glare command: ${err}`)
        }
    }
}
