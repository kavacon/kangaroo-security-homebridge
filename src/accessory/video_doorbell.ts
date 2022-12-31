import {
    CharacteristicGetHandler,
    CharacteristicSetHandler,
    CharacteristicValue,
    HAP,
    Logging, Nullable,
    PlatformAccessory,
    Service
} from "homebridge";
import {AlarmType, Device, DOORBELL_ALARM, KangarooContext, MOTION_ALARM} from "../model";
import {getDevice, nonDismissedAlarms, updateDeviceCam} from "../client";
import {StreamingDelegate} from "../camera/streaming_delegate"

export class VideoDoorbellService {
    private readonly log: Logging;
    private readonly hap: HAP;

    constructor(log: Logging, hap: HAP) {
        this.log = log;
        this.hap = hap;
    }
    
    configure(device: Device, accessory: PlatformAccessory<KangarooContext>): { accessory: PlatformAccessory<KangarooContext>, cleanup: () => void } {
        const { context } = accessory;
        accessory.addService(this.configureDoorbell(context));
        accessory.addService(this.configureMotionSensor(context));
        accessory.addService(this.configureCamera(device, context))

        const videoConfig = {deviceId: device.deviceId, homeId: context.homeId}
        const delegate = new StreamingDelegate(this.log, videoConfig, this.hap, device.deviceName);
        accessory.configureController(delegate.controller);
        return {accessory, cleanup: () => { accessory.removeController(delegate.controller); delegate.shutdown() }};
    }
    
    update(device: Device, accessory: PlatformAccessory<KangarooContext>): { accessory: PlatformAccessory<KangarooContext>, cleanup: () => void } {
        accessory.removeService(accessory.getService(this.hap.Service.Doorbell)!);
        accessory.removeService(accessory.getService(this.hap.Service.MotionSensor)!);
        accessory.removeService(accessory.getService(this.hap.Service.CameraOperatingMode)!);
        return this.configure(device, accessory);
    }

    private configureDoorbell(context: KangarooContext): Service {
        const doorbellService = new this.hap.Service.Doorbell()
        const button = doorbellService.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent);
        button.onGet(this.getWith(context, context => VideoDoorbellService.isActiveAlarmType(DOORBELL_ALARM, context).then(result => result ? this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS : null)));
        return doorbellService;
    }

    private configureMotionSensor(context: KangarooContext): Service {
        const motionSensorService = new this.hap.Service.MotionSensor();
        const motionSensor = motionSensorService.getCharacteristic(this.hap.Characteristic.MotionDetected);
        motionSensor.onGet(this.getWith(context, context => VideoDoorbellService.isActiveAlarmType(MOTION_ALARM, context)));
        return motionSensorService;
    }

    private configureCamera(device: Device, context: KangarooContext): Service {
        const cameraService = new this.hap.Service.CameraOperatingMode();
        cameraService
            .getCharacteristic(this.hap.Characteristic.EventSnapshotsActive)
            .onSet(this.setWith(context, VideoDoorbellService.handleEventSnapshotsActiveSet))
            .updateValue(this.hap.Characteristic.EventSnapshotsActive.ENABLE);
        cameraService
            .getCharacteristic(this.hap.Characteristic.HomeKitCameraActive)
            .onGet(this.getWith(context, this.handleHomeKitCameraActiveGet.bind(this)))
            .updateValue(device.online ? this.hap.Characteristic.HomeKitCameraActive.ON : this.hap.Characteristic.HomeKitCameraActive.OFF)
        cameraService
            .getCharacteristic(this.hap.Characteristic.NightVision)
            .onGet(this.getWith(context, VideoDoorbellService.handleHomeKitNightVisionGet))
            .onSet(this.setWith(context, VideoDoorbellService.handleHomeKitNightVisionSet));
        cameraService.isPrimaryService = true;
        return cameraService;
    }

    private getWith(context: KangarooContext, getter: (context: KangarooContext) => Promise<Nullable<CharacteristicValue>>): CharacteristicGetHandler {
        return () => {
            this.log.info('getting characteristic for %s', context.deviceId)
            return getter(context)
                .catch(reason => {
                    this.log.error('failed to get characteristic value for %s with error %s', context.deviceId, reason);
                    return null
                })
        };
    }

    private setWith(context: KangarooContext, setter: (value: CharacteristicValue, context: KangarooContext) => Promise<Nullable<CharacteristicValue>>): CharacteristicSetHandler {
        return (value) => {
            this.log.info('setting characteristic for %s', context.deviceId)
            return setter(value, context)
                .catch(reason => {
                    this.log.error('failed to set characteristic value %s for %s with error %s', value, context.deviceId, reason);
                    return null
                })
        };
    }

    private static handleEventSnapshotsActiveSet(value: CharacteristicValue, context: KangarooContext): Promise<CharacteristicValue> {
        return Promise.resolve(value);
    }

    private handleHomeKitCameraActiveGet(context: KangarooContext): Promise<CharacteristicValue> {
        return getDevice(context.homeId, context.deviceId)
            .then(d => d.online ? this.hap.Characteristic.HomeKitCameraActive.ON : this.hap.Characteristic.HomeKitCameraActive.OFF);
    }

    private static handleHomeKitNightVisionGet(context: KangarooContext): Promise<CharacteristicValue> {
        return getDevice(context.homeId, context.deviceId)
            .then(d => d.irLed);
    }

    private static handleHomeKitNightVisionSet(value: CharacteristicValue, context: KangarooContext): Promise<CharacteristicValue> {
        if (value) {
            return updateDeviceCam(context.homeId, context.deviceId, {irLed: true})
                .then(_ => true)
        }
        return updateDeviceCam(context.homeId, context.deviceId, {irLed: false})
            .then(_ => false);
    }

    private static isActiveAlarmType(type: AlarmType, context: KangarooContext): Promise<boolean> {
        const res = nonDismissedAlarms(context.homeId)
        return res.then(
            alarms => {
                return alarms.some(a => a.deviceId === context.deviceId && a.alarmType == type);
            }
        );
    }
}