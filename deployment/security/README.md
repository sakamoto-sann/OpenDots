# Container incident trust policy

The image build uses the security-fixed Node 24.22.1 and Bun 1.4.4 runtimes. The external public CA bundle excludes the incident trust paths and is loaded through the standard TLS environment variables.

Supply the existing Takumi-backed npm guard configuration as the BuildKit `npmrc` secret. The guard must be available on its existing port 4873 through loopback or Tailscale. Builds fail closed without that secret; lifecycle scripts remain disabled. `guard-lock.mjs` keeps pinned versions and integrity values while routing registry artifacts through that guard. Do not put registry credentials in build arguments, the source tree, or image layers.

These are public CA certificates. This is a fixed incident snapshot and should be refreshed from the maintained OS CA source as part of future image updates, while retaining incident rejection tests.

For Compose builds, set `NPM_GUARD_NPMRC` to the existing guard configuration file path. Compose passes it as a build secret to each image build. A direct build needs `--secret id=npmrc,src="$NPM_GUARD_NPMRC"`. The `command-runner` stage only installs OS build tools and does not install npm packages.

Starting existing images does not require a registry configuration. Without the build configuration, Compose supplies `/dev/null` and the package preflight rejects the build before any package install.
