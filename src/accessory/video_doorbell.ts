import {CharacteristicValue, HAP, Logging, PlatformAccessory, Service} from "homebridge";
import {AlarmType, Device, DOORBELL_ALARM, KangarooContext, MOTION_ALARM} from "../model";
import {getDevice, nonDismissedAlarms, updateDeviceCam} from "../client";
import {StreamingDelegate} from "../camera/streaming_delegate"

export function configureVideoDoorbell(log: Logging, hap: HAP, tempStorage: string, device: Device, accessory: PlatformAccessory<KangarooContext>): { accessory: PlatformAccessory<KangarooContext>, cleanup: () => void} {
    accessory.addService(configureDoorbell(hap));
    accessory.addService(configureMotionSensor(hap));
    accessory.addService(configureCamera(hap))

    const videoConfig = { deviceId: device.deviceId, homeId: accessory.context.homeId }
    const delegate = new StreamingDelegate(log, videoConfig, hap, device.deviceName, tempStorage);
    accessory.configureController(delegate.controller);
    return { accessory, cleanup: delegate.shutdown };
}

export function updateVideoDoorbell(log: Logging, hap: HAP, tempStorage: string, device: Device, accessory: PlatformAccessory<KangarooContext>): { accessory: PlatformAccessory<KangarooContext>, cleanup: () => void}  {
    const videoConfig = { deviceId: device.deviceId, homeId: accessory.context.homeId }
    const delegate = new StreamingDelegate(log, videoConfig, hap, device.deviceName, tempStorage);
    accessory.configureController(delegate.controller);

    const cameraService = accessory.getService(hap.Service.CameraOperatingMode);
    cameraService?.getCharacteristic(hap.Characteristic.HomeKitCameraActive).updateValue(device.online);
    cameraService?.getCharacteristic(hap.Characteristic.NightVision).updateValue(device.irLed);
    return { accessory, cleanup: delegate.shutdown };
}

function configureDoorbell(hap: HAP): Service {
    const doorbellService = new hap.Service.Doorbell()
    const button = doorbellService.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent);
    button.onGet((context) => isActiveAlarmType(DOORBELL_ALARM, context));
    return doorbellService;
}

function configureMotionSensor(hap: HAP): Service  {
    const motionSensorService = new hap.Service.MotionSensor();
    const motionSensor = motionSensorService.getCharacteristic(hap.Characteristic.MotionDetected);
    motionSensor.onGet((context) => isActiveAlarmType(MOTION_ALARM, context));
    return motionSensorService;
}

function configureCamera(hap: HAP): Service {
    const cameraService = new hap.Service.CameraOperatingMode();
    cameraService
        .getCharacteristic(hap.Characteristic.EventSnapshotsActive)
        .onSet(handleEventSnapshotsActiveSet);
    cameraService
        .getCharacteristic(hap.Characteristic.HomeKitCameraActive)
        .onGet(handleHomeKitCameraActiveGet);
    cameraService
            .getCharacteristic(hap.Characteristic.NightVision)
            .onGet(handleHomeKitNightVisionGet)
            .onSet((value, context) => handleHomeKitNightVisionSet(hap, value, context));
    return cameraService;
}

function handleEventSnapshotsActiveSet(value: CharacteristicValue): Promise<CharacteristicValue>  {
    return Promise.resolve(value);
}

function handleHomeKitCameraActiveGet(context: KangarooContext): Promise<CharacteristicValue>  {
    return getDevice(context.homeId, context.deviceId)
        .then(d => d.online);
}

function handleHomeKitNightVisionGet(context: KangarooContext): Promise<CharacteristicValue> {
    return getDevice(context.homeId, context.deviceId)
        .then(d => d.irLed);
}

function handleHomeKitNightVisionSet(hap: HAP, value: CharacteristicValue, context: KangarooContext): Promise<CharacteristicValue> {
    if (value) {
        return updateDeviceCam(context.homeId, context.deviceId, { irLed: true})
            .then(_ => true);
    }
    return updateDeviceCam(context.homeId, context.deviceId, { irLed: false})
        .then(_ => false);
}

function isActiveAlarmType(type: AlarmType, context: KangarooContext): Promise<CharacteristicValue> {
    const res = nonDismissedAlarms(context.homeId)
    return res.then(
        alarms => {
            return alarms.some(a => a.deviceId === context.deviceId && a.alarmType == type);
        }
    );
}