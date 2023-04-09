import path from "path";
import {Logger} from "homebridge";

export type NamedProcess<T> = {process: Promise<T>, name: string}

export type RuntimeOptions = {
    log: Logger
    debugMsg?: string;
    warnTime?: {time: number, msg: string};
    errorTime?: {time: number, msg: string}
}
export const enum Resource {
    PLACEHOLDER = 'loading.gif'
}

export function getResourcePath(resource: Resource): string {
    return path.join(__dirname, 'resources', resource);
}

export function thenWithRuntime<T>(processSupplier: () => NamedProcess<T>, options: RuntimeOptions): Promise<T> {
    const startTime = Date.now();
    const {process, name} = processSupplier()
    return process.then(
        value => {
            const runtime = (Date.now() - startTime) / 1000;
            const infoMsg = `${name} took ${runtime} seconds`;
            if (options.errorTime && runtime >= options.errorTime.time) {
                options.log.error(infoMsg, options.errorTime.msg);
            } else if (options.warnTime && runtime >= options.warnTime.time) {
                options.log.warn(infoMsg, options.warnTime.msg)
            } else if (options.debugMsg) {
                options.log.debug(infoMsg, options.debugMsg)
            } else {
                options.log.info(infoMsg);
            }
            return value;
        }
    )
}