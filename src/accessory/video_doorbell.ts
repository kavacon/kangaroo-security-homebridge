import {
    CameraControllerOptions,
    CameraStreamingDelegate,
    CharacteristicGetHandler,
    CharacteristicSetHandler,
    CharacteristicValue,
    DoorbellController,
    DoorbellOptions,
    HAP,
    Logging,
    Nullable,
    PlatformAccessory,
    Service
} from "homebridge";
import {Alarm, BatteryStatus, Device, KangarooContext} from "../model";
import {Client} from "../client/client";
import {StreamingDelegate} from "../camera/streaming_delegate"
import {NotificationService} from "../notification/notification_service";

export class VideoDoorbellService {
    private readonly log: Logging;
    private readonly hap: HAP;
    private readonly client: Client;
    private readonly notificationService: NotificationService;

    constructor(log: Logging, hap: HAP, client: Client, notificationService: NotificationService) {
        this.log = log;
        this.hap = hap;
        this.client = client;
        this.notificationService = notificationService;
    }
    
    configure(device: Device, accessory: PlatformAccessory<KangarooContext>): { accessory: PlatformAccessory<KangarooContext>, cleanup: () => void } {
        const { context } = accessory;
        const cameraOperatingMode = this.configureCamera(device, context);
        const battery = this.configureBattery(device, context);
        accessory.addService(cameraOperatingMode);
        accessory.addService(battery);

        const delegate = new StreamingDelegate(this.log, this.hap, device.deviceName, device.lastAlarm);
        const doorbellOptions = this.getDoorbellControllerOptions(delegate, device.deviceName)
        const doorbellController = new this.hap.DoorbellController(doorbellOptions);
        doorbellController.motionService?.getCharacteristic(this.hap.Characteristic.StatusActive).updateValue(true);
        delegate.on('stream_error', (sessionID) => doorbellController.forceStopStreamingSession(sessionID));

        accessory.configureController(doorbellController);
        this.configureNotifications(device.deviceId, doorbellController, delegate);
        return {accessory, cleanup: () => { accessory.removeController(doorbellController); delegate.shutdown() }};
    }
    
    update(device: Device, accessory: PlatformAccessory<KangarooContext>): { accessory: PlatformAccessory<KangarooContext>, cleanup: () => void } {
        accessory.removeService(accessory.getService(this.hap.Service.CameraOperatingMode)!);
        accessory.removeService(accessory.getService(this.hap.Service.Battery)!);
        return this.configure(device, accessory);
    }

    private configureNotifications(deviceId: string, controller: DoorbellController, delegate: StreamingDelegate) {
        this.notificationService.on(`doorbell_ring_${deviceId}`, delegate.updateAlarm.bind(delegate));
        this.notificationService.on(`doorbell_ring_${deviceId}`, _ => controller.ringDoorbell());

        this.notificationService.on(`motion_detected_${deviceId}`, delegate.updateAlarm.bind(delegate));
        this.notificationService.on(`motion_detected_${deviceId}`, this.motionListener(controller));
    }

    private motionListener(controller: DoorbellController): (alarm: Alarm) => void {
        return _ => {
            controller.motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).sendEventNotification(true);
            setTimeout(() =>
                controller.motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).updateValue(false)
                , 30000);
        }
    }

    private getDoorbellControllerOptions(delegate: CameraStreamingDelegate, name: string): DoorbellOptions & CameraControllerOptions {
        return {
            cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
            delegate: delegate,
            streamingOptions: {
                supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions: [
                        [320, 180, 30],
                        [320, 240, 15], // Apple Watch requires this configuration
                        [320, 240, 30],
                        [480, 270, 30],
                        [480, 360, 30],
                        [640, 360, 30],
                        [640, 480, 30],
                        [1280, 720, 30],
                        [1280, 960, 30],
                        [1920, 1080, 30],
                        [1600, 1200, 30]
                    ],
                    codec: {
                        profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
                        levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0]
                    }
                },
            },
            sensors: {
                motion: true
            },
            name,
        };
    }

    private configureCamera(device: Device, context: KangarooContext): Service {
        const cameraService = new this.hap.Service.CameraOperatingMode(device.deviceName);
        cameraService
            .getCharacteristic(this.hap.Characteristic.EventSnapshotsActive)
            .onSet(this.setWith(context, this.handleEventSnapshotsActiveSet.bind(this)))
            .updateValue(this.hap.Characteristic.EventSnapshotsActive.ENABLE);
        cameraService
            .getCharacteristic(this.hap.Characteristic.HomeKitCameraActive)
            .onGet(this.getWith(context, this.handleHomeKitCameraActiveGet.bind(this)))
            .updateValue(device.online ? this.hap.Characteristic.HomeKitCameraActive.ON : this.hap.Characteristic.HomeKitCameraActive.OFF)
        cameraService
            .getCharacteristic(this.hap.Characteristic.NightVision)
            .onGet(this.getWith(context, this.handleHomeKitNightVisionGet.bind(this)))
            .onSet(this.setWith(context, this.handleHomeKitNightVisionSet.bind(this)));
        cameraService.isPrimaryService = true;
        return cameraService;
    }

    private configureBattery(device: Device, context: KangarooContext): Service {
        const battery = new this.hap.Service.Battery(device.deviceName);
        battery.getCharacteristic(this.hap.Characteristic.StatusLowBattery)
            .onGet(this.getWith(context, this.handleStatusLowBatteryGet.bind(this)))
            .updateValue(device.batteryStatus === BatteryStatus.OK
                ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
                : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            );
        return battery;
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

    private setWith(context: KangarooContext, setter: (value: CharacteristicValue, context: KangarooContext) => Promise<Nullable<CharacteristicValue> | void>): CharacteristicSetHandler {
        return (value) => {
            this.log.info('setting characteristic for %s', context.deviceId)
            return setter(value, context)
                .catch(reason => {
                    this.log.error('failed to set characteristic value %s for %s with error %s', value, context.deviceId, reason);
                    return null
                })
        };
    }

    private handleStatusLowBatteryGet(context: KangarooContext):  Promise<CharacteristicValue> {
        return this.client.getDevice(context.homeId, context.deviceId)
            .then(d => d.batteryStatus === BatteryStatus.OK
                ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
                : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    }

    private handleEventSnapshotsActiveSet(value: CharacteristicValue, context: KangarooContext): Promise<void> {
        this.log.info(`request set event snapshots active for device ${context.deviceId}`);
        return Promise.resolve();
    }

    private handleHomeKitCameraActiveGet(context: KangarooContext): Promise<CharacteristicValue> {
        return this.client.getDevice(context.homeId, context.deviceId)
            .then(d => d.online ? this.hap.Characteristic.HomeKitCameraActive.ON : this.hap.Characteristic.HomeKitCameraActive.OFF);
    }

    private handleHomeKitNightVisionGet(context: KangarooContext): Promise<CharacteristicValue> {
        return this.client.getDevice(context.homeId, context.deviceId)
            .then(d => d.irLed);
    }

    private async handleHomeKitNightVisionSet(value: CharacteristicValue, context: KangarooContext): Promise<void> {
        const res = await this.client.updateDeviceCam(context.homeId, context.deviceId, {irLed: !!value});
        this.log.info(`run set night vision for device ${context.deviceId} requested ${!!value} set ${res.irLed}`);
        return Promise.resolve()
    }
}