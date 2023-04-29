import {
    CharacteristicGetHandler,
    CharacteristicSetHandler,
    CharacteristicValue,
    HAP,
    Logging,
    Nullable,
    PlatformAccessory, PlatformConfig
} from "homebridge";
import {Device, KangarooContext} from "../model";
import {Client} from "../client/client";

export abstract class Accessory {
    readonly platformAccessory: PlatformAccessory<KangarooContext>
    protected readonly hap: HAP;
    protected readonly log: Logging;
    protected readonly client: Client

    constructor(platformAccessory: PlatformAccessory<KangarooContext>, hap: HAP, log: Logging, client: Client) {
        this.platformAccessory = platformAccessory;
        this.hap = hap;
        this.log = log;
        this.client = client;
    }

    getDeviceId(): string {
        return this.platformAccessory.context.deviceId;
    }

    protected safeGet(getter: () => Promise<Nullable<CharacteristicValue>>): CharacteristicGetHandler {
        return () => {
            this.log.info('getting characteristic for %s', this.getDeviceId())
            return getter()
                .catch(reason => {
                    this.log.error('failed to get characteristic value for %s with error %s', this.getDeviceId(), reason);
                    return null
                })
        };
    }

    protected safeSet(setter: (value: CharacteristicValue) => Promise<Nullable<CharacteristicValue> | void>): CharacteristicSetHandler {
        return (value) => {
            this.log.info('setting characteristic for %s', this.getDeviceId())
            return setter(value)
                .catch(reason => {
                    this.log.error('failed to set characteristic value %s for %s with error %s', value, this.getDeviceId(), reason);
                    return null
                })
        };
    }

    abstract initialise(device: Device, config?: PlatformConfig);

    abstract onUpdate(device: Device, homeId: string): void;

    abstract onRemove(): void;
}