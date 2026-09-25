# Database certificate authority

`supabase-prod-ca-2021.crt` is Supabase's public root CA, downloaded from
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt.
It contains no private key or credential. SHA-256 certificate fingerprint:
`807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.
The certificate expires on 26 April 2031.

The service image includes it at
`/app/certificates/supabase-prod-ca-2021.crt`. Configure the dedicated
`ALBERT_OMNI_JOB_DATABASE_URL` with `sslmode=verify-full` and
`sslrootcert=/app/certificates/supabase-prod-ca-2021.crt` so both the issuing
authority and database hostname are verified. Local migration commands can
use this source file's absolute path instead.

See [Supabase's SSL configuration documentation](https://supabase.com/docs/guides/platform/ssl-enforcement).
