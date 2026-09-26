# Finesse Flow Media Worker v1.1

Dockerized native-FFmpeg assembly worker for Finesse Flow.

## Flow

`POST /assemble` -> authenticate -> download scene MP4s -> normalize -> concatenate -> brand -> upload final MP4 to Supabase Storage -> callback Finesse Flow -> cleanup.

## Storage

Preconfigured for the dedicated Supabase project `finesse-flow` and bucket `finesse-flow-exports`. The bucket is public-read MP4 storage. Uploads use a server-side Supabase secret key. Never expose that key to a browser or commit it.

Required host secrets:

- `WORKER_TOKEN`
- `SUPABASE_SECRET_KEY`
- `FINESSE_FLOW_CALLBACK_TOKEN` if the callback endpoint is protected by a worker token

Non-secret defaults are shown in `.env.example`.

## Endpoints

- `GET /health` verifies native FFmpeg is installed.
- `POST /assemble` accepts the Finesse Flow Assembly Bridge payload.

## Deployment

Build the included Dockerfile on any Docker-capable host. Enter secrets directly in that host's secret/environment-variable UI. Do not paste them into chat.
