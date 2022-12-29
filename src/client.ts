import fetch from 'node-fetch';
import {Account, Alarm, Device} from "./model";

const BASE_URL = 'https://api.heykangaroo.com/v1/me'
let authToken = '';

function send(url: string, method: string, body?: any): Promise<string> {
    return fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
    });
}

export function devicesAndTags(homeId: string): Promise<Device[]> {
    return send(`${BASE_URL}/homes/${homeId}/devicesAndTags`, 'GET')
        .then(result => JSON.parse(result))
}

export function getDevice(homeId: string, deviceId: string): Promise<Device> {
    return send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'GET')
        .then(result => JSON.parse(result))
}

export function updateDevice(homeId: string, deviceId: string, update: Partial<Device>): Promise<Device> {
    return send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'PUT', update)
        .then(result => JSON.parse(result))
}

export function updateDeviceCam(homeId: string, deviceId: string, update: Partial<Device>): Promise<Device> {
    return send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}/doorCamAlertSetting`, 'PUT', update)
        .then(result => JSON.parse(result))
}

export function nonDismissedAlarms(homeId: string): Promise<Alarm[]> {
    return send(`${BASE_URL}/homes/${homeId}/alarms/nondismissed`, 'GET')
        .then(result => JSON.parse(result))
}

export function account(): Promise<Account> {
    return send(BASE_URL, 'GET')
        .then(result => JSON.parse(result))
}

export function updateAuth(token: string) {
    authToken = token;
}