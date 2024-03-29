import {API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig} from 'homebridge';
import {KangarooContext} from "./model";
import {AccessoryService} from "./accessory/accessory_service";
import {Client} from "./client/client";
import {AuthManager} from "./client/auth_manager";
import {NotificationService} from "./notification/notification_service";

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
    private readonly config: PlatformConfig;
    private readonly accessoryService: AccessoryService;
    private readonly notificationService: NotificationService;
    private readonly client: Client;
    
    constructor(log: Logging, config: PlatformConfig, api: API) {
        this.log = log;
        this.api = api;
        this.config = config;

        const authManager = new AuthManager(log, config.refreshToken, config.secureTokenKey);
        this.client = new Client(log, authManager);
        this.notificationService = new NotificationService(log, this.client)
        const accessoryApi = {
            Accessory: this.api.platformAccessory,
            register: a => this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, a),
            unregister: a => this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, a),
        }
        this.accessoryService = new AccessoryService(log, accessoryApi, hap, config, this.client);

        this.log.info('Kangaroo Security bridge starting up');
        // Only occurs once all existing accessories have been loaded
        this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.apiDidFinishLaunching());
        this.api.on(APIEvent.SHUTDOWN, () => this.shutdown())
    }

    configureAccessory(accessory: PlatformAccessory<KangarooContext>): void {
        this.log.info('loading saved accessory: [%s]', accessory.displayName);
        this.accessoryService.addCachedAccessory(accessory);
    }

    private apiDidFinishLaunching() {
        const res = this.client.account();
        res.then( res => {
            res.homes.forEach(
                home => home.devices.forEach( device => this.accessoryService.addDevice(device, home.homeId))
            )
            this.accessoryService.onApiDidFinishLaunching();
        })
            .catch( reason => this.log.error('Error during accessory loading: [%s]', reason))
            .finally(() => {
                this.setupNotifications();
            });
    }

    private setupNotifications() {
        this.notificationService.on('new_device', (device, homeId) => {
            const accessory = this.accessoryService.addDevice(device, homeId);
            accessory && this.notificationService.on(`device_update_${accessory.getDeviceId()}`, (d, h) => accessory.onUpdate(d, h))
            this.accessoryService.registerPendingAccessories();
        });
        this.notificationService.on('removed_device', d => this.accessoryService.removeAccessory(d))
        this.notificationService.start(this.accessoryService.getRegisteredAccessories());
    }

    private shutdown() {
        this.notificationService.onShutdown();
        this.accessoryService.onShutdown();
    }
}