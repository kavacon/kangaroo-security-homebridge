import {Accessory} from "./accessory";
import {
    CameraControllerOptions,
    CameraStreamingDelegate, CharacteristicValue,
    DoorbellController,
    DoorbellOptions,
    HAP,
    PlatformConfig
} from "homebridge";
import {StreamingDelegate} from "../camera/streaming_delegate";
import {BatteryStatus, Device, DOORBELL_ALARM, MOTION_ALARM} from "../model";

// TODO support dynamically removing motion service when motion detection false
export class VideoDoorbell extends Accessory {

    private doorbellController?: DoorbellController;
    private cameraStream?: StreamingDelegate;
    lastAlarmId?: string

    initialise(config: PlatformConfig) {
        this.addCamera();
        this.addBattery();
        this.cameraStream = new StreamingDelegate(this.log, this.hap, this.device.deviceName, this.device.lastAlarm, config.videoStitchOptions);
        this.doorbellController = buildDoorbell(this.hap, this.cameraStream, this.getDeviceId())
        this.cameraStream.on('stream_error', (sessionID) => this.doorbellController?.forceStopStreamingSession(sessionID));
        this.platformAccessory.configureController(this.doorbellController);
    }

    processDeviceUpdate(device: Device) {
        if (device.lastAlarm && device.lastAlarm.alarmId !== this.lastAlarmId) {
            this.lastAlarmId = device.lastAlarm.alarmId;
            this.cameraStream?.updateAlarm(device.lastAlarm);
            switch (device.lastAlarm.alarmType) {
                case DOORBELL_ALARM:
                    this.log.debug(`doorbell ring for device ${this.getDeviceId()}, alarm ${this.lastAlarmId}`);
                    this.doorbellController?.ringDoorbell();
                    return;
                case MOTION_ALARM:
                    this.log.debug(`motion detected for device ${this.getDeviceId()}, alarm ${this.lastAlarmId}`);
                    this.doorbellController?.motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).sendEventNotification(true);
                    setTimeout(() =>
                            this.doorbellController?.motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).updateValue(false)
                        , 30000);
                    return;
                default:
                    this.log.warn(`unable to process for alarm type: ${device.lastAlarm.alarmType} for device ${this.getDeviceId()}`);
                    return;
            }
        }
    }

    onRemove() {
        this.cameraStream?.removeAllListeners();
        this.cameraStream?.shutdown();
        this.doorbellController?.removeAllListeners()
        this.doorbellController && this.platformAccessory.removeController(this.doorbellController);
    }

    private addCamera() {
        const previousService = this.platformAccessory.getService(this.hap.Service.CameraOperatingMode)
        const cameraService = previousService || new this.hap.Service.CameraOperatingMode(this.device.deviceName);
        cameraService
            .getCharacteristic(this.hap.Characteristic.EventSnapshotsActive)
            .removeOnSet()
            .onSet(this.handleEventSnapshotsActiveSet.bind(this))
            .updateValue(this.hap.Characteristic.EventSnapshotsActive.ENABLE);
        cameraService
            .getCharacteristic(this.hap.Characteristic.HomeKitCameraActive)
            .removeOnGet()
            .onGet(this.loggedGet('HomeKitCameraActive', this.handleHomeKitCameraActiveGet.bind(this)))
            .updateValue(this.device.online ? this.hap.Characteristic.HomeKitCameraActive.ON : this.hap.Characteristic.HomeKitCameraActive.OFF)
        cameraService
            .getCharacteristic(this.hap.Characteristic.NightVision)
            .removeOnGet()
            .removeOnSet()
            .onGet(this.loggedGet('HomeKitNightVision', this.handleHomeKitNightVisionGet.bind(this)))
            .onSet(this.updatingSet('HomeKitNightVision', this.buildHomeKitNightVisionSetUpdate.bind(this)));
        cameraService.isPrimaryService = true;
        !previousService && this.platformAccessory.addService(cameraService)
    }

    private addBattery() {
        const previousService = this.platformAccessory.getService(this.hap.Service.Battery)
        const battery = previousService || new this.hap.Service.Battery(this.device.deviceName);
        battery.getCharacteristic(this.hap.Characteristic.StatusLowBattery)
            .removeOnGet()
            .onGet(this.loggedGet('StatusLowBattery', this.handleStatusLowBatteryGet.bind(this)))
            .updateValue(this.device.batteryStatus === BatteryStatus.OK
                ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
                : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            );
        battery.getCharacteristic(this.hap.Characteristic.BatteryLevel)
            .removeOnGet()
            .onGet(this.loggedGet('BatteryLevel', this.handleBatteryLevelGet.bind(this)))
            .updateValue(this.device.batteryVolume);
        !previousService && this.platformAccessory.addService(battery);
    }

    private handleStatusLowBatteryGet(): CharacteristicValue {
        return this.device.batteryStatus === BatteryStatus.OK
            ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
            : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    }

    private handleBatteryLevelGet(): CharacteristicValue {
        return this.device.batteryVolume || 0;
    }

    private handleEventSnapshotsActiveSet(value: CharacteristicValue): Promise<void> {
        this.log.info(`request set event snapshots active for device ${this.getDeviceId()}`);
        return Promise.resolve();
    }

    private handleHomeKitCameraActiveGet(): CharacteristicValue {
        return this.device.online ? this.hap.Characteristic.HomeKitCameraActive.ON : this.hap.Characteristic.HomeKitCameraActive.OFF;
    }

    private handleHomeKitNightVisionGet(): CharacteristicValue {
        return this.device.irLed;
    }

    private buildHomeKitNightVisionSetUpdate(value: CharacteristicValue): Partial<Device> {
        return {irLed: !!value};
    }
}

function buildDoorbell(hap: HAP, cameraStream: CameraStreamingDelegate, device: string) {
    const doorbellOptions = buildCameraDoorbellOptions(hap, cameraStream, device)
    const doorbellController = new hap.DoorbellController(doorbellOptions);
    doorbellController.motionService?.getCharacteristic(hap.Characteristic.StatusActive).updateValue(true);
    return doorbellController;
}

function buildCameraDoorbellOptions(hap: HAP, delegate: CameraStreamingDelegate, name: string): DoorbellOptions & CameraControllerOptions {
    return {
        cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
        delegate: delegate,
        streamingOptions: {
            supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
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
                    profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                    levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0]
                }
            },
        },
        sensors: {
            motion: true
        },
        name,
    };
}