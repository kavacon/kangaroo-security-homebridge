import {API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig} from 'homebridge';
import {KangarooContext} from "./model";
import {AccessoryService} from "./accessory/accessory_service";
import {account, setLog} from "./client";

const PLUGIN_NAME = 'kangaroo-security-homebridge';
const PLATFORM_NAME = 'KangarooSecurity';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

export = (api: API) => {
    hap = api.hap;
    Accessory = api.platformAccessory;
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, KangarooSecurityPlatform);
};

class KangarooSecurityPlatform implements DynamicPlatformPlugin {
    private readonly log: Logging;
    private readonly api: API;
    private readonly accessoryService: AccessoryService;
    private deleteQueue: PlatformAccessory<KangarooContext>[] = [];
    private cachedAccessories: PlatformAccessory<KangarooContext>[] = [];
    private accessories: PlatformAccessory<KangarooContext>[] = [];
    private shutdownActions: (() => void)[] = []
    
    constructor(log: Logging, config: PlatformConfig, api: API) {
        this.log = log;
        this.api = api;
        this.accessoryService = new AccessoryService(log, api, hap);
        setLog(log);
        this.log.info('Kangaroo Security bridge starting up');
        // Only occurs once all existing accessories have been loaded
        this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.apiDidFinishLaunching());
        this.api.on(APIEvent.SHUTDOWN, () => this.shutdown())
    }

    configureAccessory(accessory: PlatformAccessory<KangarooContext>): void {
        this.log.info('loading saved accessory: [%s]', accessory.displayName);
        this.accessoryService.updateAccessory(accessory)
            .then(({ accessory, cleanup }) => {
                this.cachedAccessories.push(accessory);
                cleanup && this.shutdownActions.push(cleanup);
            })
            .catch( reason => {
                this.log.error('Accessory %s update failed with reason: %s, scheduling for removal', accessory.displayName, reason);
                this.deleteQueue.push(accessory)
            })
            .finally(() => this.log.info('Cached accessory %s processed', accessory.displayName));
    }

    private apiDidFinishLaunching() {
        this.log.info('apiDidFinishLaunching callback activating');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.deleteQueue);
        this.deleteQueue = [];

        // get auth token
        // store somewhere
        // retrieve home details using client
        const res = account();
        res.then( res => {
            res.homes.forEach(
                home => {
                    // create new accessories
                    home.devices
                        .filter( ({ deviceId }) => !this.cachedAccessories.some( ({ context }) => context.deviceId === deviceId))
                        .forEach( device => {
                            const { accessory, cleanup } = this.accessoryService.fromDevice(device, home.homeId);
                            this.accessories.push(accessory);
                            cleanup && this.shutdownActions.push(cleanup);
                        })
                }
            )
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
        })
            .catch( reason => this.log.error('Error during accessory loading: [%s]', reason))
            .finally(() =>
                this.log.info('Accessory setup completed, %s accessories created, %s cached accessories maintained',
                    this.accessories.length, this.cachedAccessories.length)
            );
    }

    private shutdown() {
        this.shutdownActions.forEach(a => a());
    }
}