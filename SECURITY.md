# Security

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/onl1yw/semantic-calculator/security/advisories/new).
If reporting is unavailable, contact the repository owner through their GitHub
profile. Do not post credentials, personal data, or exploit details in public issues.

## Application boundary

The browser stores calculations, memory, history, and personal definitions locally.
The API accepts dictionary queries and transient result vectors. Access logs are
disabled; request validation errors do not echo submitted vectors.

The public server exposes only the built frontend and dictionary API. It does not
serve model archives, database files, environment files, or cloud credentials.
No account or cross-device synchronization is currently implemented.

## Deployment boundary

Deploy only through the protected gateway described in
[the deployment guide](docs/deployment.md). Keep the container private. Runtime
uses a separate service account with pull access to its own image registry.
The dictionary is bundled into the image and verified at startup; application
requests need no cloud database or IAM credentials. Gateway invocation rights
are scoped to the application container.

Limits are enforced at the gateway, container revision, and application.
Instance caps in Yandex Cloud apply **per availability zone**. Billing alerts are
notifications, not a spending cap; gateway and security traffic can still cost money.

## Repository boundary

Models, database exports, credentials, local environment files, and Terraform state
are excluded from Git. Use local IAM credentials or metadata credentials; never
place long-lived keys in frontend code, Docker build arguments, or CI logs.
Dependencies are locked and audited in CI. Enable GitHub secret scanning, push
protection, and private vulnerability reporting in the repository settings.
