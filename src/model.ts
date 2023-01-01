import {MacAddress} from "homebridge/lib/util/mac";

export enum DeviceType {
    DOORCAM = "DOORCAM",
}

enum Country {
    AU = "AU",
}

export const DOORBELL_ALARM = 801;
export const MOTION_ALARM = 101;
type BatteryStatus = 'ok';
export type AlarmType = typeof DOORBELL_ALARM | typeof MOTION_ALARM | 3 | 1;
type ArmType = 2;
type OwnershipType = 'owner' | 'renter';


interface PlanActivation {
    activationLinkSentViaSms: boolean,
    activated: boolean,
    qrScanEnable: boolean,
    mandatory: boolean,
    planId: string
}

export interface Alarm {
    alarmId: string,
    deviceId: string,
    homeId: string,
    alarmType: AlarmType,
    backCoverOpened: boolean,
    images: string[],
    imageID: number,
    createTime: string,
    delUser: string,
    mediaStatus: number,
}

export interface Device {
    deviceId: string,
    deviceType: DeviceType,
    deviceModel: string,
    hardwareRevision: string,
    deviceName: string,
    voltage: number,
    thingName: string,
    mac: MacAddress,
    room: string,
    fwVersion: number,
    appNotification: boolean,
    textNotification: boolean,
    voiceNotification: boolean,
    serialNumber: string,
    battery: BatteryStatus,
    batteryStatus: BatteryStatus,
    rssi: number,
    lastSyncTime: string,
    lastUpdate: string,
    online: boolean,
    location: string,
    ssid: string,
    sirenAudibleAlarm: boolean,
    allowCriticalAlerts: boolean,
    professionalMonitoring: string,
    cooldownEndTime: string,
    status: number,
    lastestFwVersion: number,
    errorCode: number,
    lastActivityDate: string,
    echoAudibleAlarm: boolean,
    firstParing: string,
    pairingCode: string,
    incompletePlanActivation: PlanActivation,
    quietMode: boolean,
    motion: boolean,
    motionEnable: boolean,
    pirSens: number,
    motionSleep: number,
    doorbell: boolean,
    appChime: boolean,
    sirenChime: boolean,
    led: boolean,
    irLed: boolean,
    lastAlarm: Alarm,
    sirenLinked: string,
    linkedSirenIds: string[],
    tooManyMotionAlerts: boolean,
    tooManyMAPopup: boolean,
    volume: number,
    ringType: number,
    chimeSoundEnabled: boolean,
    cameraSet: number,
    private: boolean
}

export interface Home {
    homeId: string,
    homeName: string,
    armType: ArmType,
    country: Country,
    streetName?: string,
    aptNO?: string,
    streetNO?: string,
    streetName2?: string,
    zip: string,
    city: string,
    state: string,
    notes: string,
    address1: string,
    address2: string,
    house?: string,
    devices: Device[],
    ownershipType: OwnershipType,
    createTime: string,
    isOwner: boolean,
    homeImage: number
}

export interface Account {
    userId: string,
    userName: string,
    firstName: string,
    lastName: string,
    phone: string,
    avatarUrl: string,
    homes: Home[],
}

export interface KangarooContext {
    homeId: string,
    deviceId: string,
    deviceType: DeviceType,
}