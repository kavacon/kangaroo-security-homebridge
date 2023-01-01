import fetch from 'node-fetch';
import {Logging} from "homebridge";

export class AuthManager {
    private readonly log: Logging;
    private readonly tokenRequest: { refreshToken: string, grantType: string };
    private readonly requestUrl: string;
    private authToken?:  Promise<string>;
    private expiredAfter?: number = undefined;

    constructor(log: Logging, refreshToken: string, secureTokenKey: string) {
        this.log = log;
        this.tokenRequest = {
            refreshToken,
            grantType: 'refresh_token',
        }
        this.requestUrl = `https://securetoken.googleapis.com/v1/token?key=${secureTokenKey}`;
    }

    getAuthToken() : Promise<string> {
        const currentTime = Date.now();
        if (!this.authToken || currentTime > this.expiredAfter!) {
            this.log.warn('auth token missing or expired, requesting new token')
            this.authToken = fetch(this.requestUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(this.tokenRequest)
            })
                .then( result => result.json())
                .then(json => {
                    this.expiredAfter = currentTime + json.expires_in;
                    return json.access_token;
                });
        }
        return this.authToken!;
    }
}