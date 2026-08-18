# Security Policy

## Reporting a vulnerability

Please use a private GitHub security advisory for this repository. Do not include OAuth access tokens, refresh tokens, device codes, authorization responses, or other credentials in public issues, pull requests, logs, or screenshots.

## Credential handling

This project is designed to store OAuth session state as one opaque credential value through DeepSeek Harness’s credential seam. Configuration and UI surfaces must expose only redacted state and actionable status, never credential values.
