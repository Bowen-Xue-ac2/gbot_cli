# Contributing

Use Node.js 24 or later. Run `npm ci` and `npm test` before sending a change.
Use synthetic chat data in tests and issue reproductions.

Use both a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off and a [GPG commit signature](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits):

```sh
git commit -s -S -m "Describe the change"
git verify-commit HEAD
```

Use your own Git identity and signing key. The sign-off certifies the origin and
licensing of your contribution. GitHub requires a registered public key and a
matching verified email to display the signature as Verified.
