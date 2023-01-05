import * as https from "https";
import {OutgoingHttpHeaders} from "http";

export type HttpMethod = 'POST' | 'PUT' |'GET';

export function fetch<T>(url: string, method: HttpMethod, headers?:OutgoingHttpHeaders, body?: any): Promise<T> {
    let result = '';
    return new Promise((resolve, reject) => {
        https.request(url, {
            method,
            headers
        })
            .on('error', err => reject(err))
            .on('response', response => {
                if (response.aborted || response.statusCode != 200) {
                    reject(`Failed ${method} ${url} with status code ${response.statusCode}`)
                }
                response.on('error', err => reject(err))
                    .on('data', data => result += data)
                    .on('end', () => resolve(JSON.parse(result)))
            })
            .end(JSON.stringify(body))
    })
}