### Homebridge Kangaroo Security plugin
This plugin supports the use of kangaroo security devices with homebridge.
Currently, it only supports video doorbells but can be extended to other device types in the future.

In order to authenticate with the kangaroo security server you must provide a refresh token and auth token used by your kangaroo
account with the google `securetoken` service. A third party app such as proxyman can be used to spy on traffic from the 
kangaroo phone app to retrieve these values. The request to monitor will be of the form
`https://securetoken.googleapis.com/v1/token?key={auth_token}` with the refresh token appearing in the body of the request.

This plugin uses ffmpeg to configure snapshots for the video feed from the doorbell and simulates a live feed
by stitching images from a doorbell notification into a looping video stream (as is done in the kangaroo app).