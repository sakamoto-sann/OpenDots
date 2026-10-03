# OpenBot computer services

OpenDots builds the supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Its source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

The computer image is built from this repository and uses Stagehand v4 for browser operations. Its authenticated API implements browser, workspace-text-file and bounded shell actions. The per-Dot credential is transferred through an anonymous descriptor and removed from child process environments. The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies one fail-closed patch to child environment construction: each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.

If the pinned upstream line changes, the patch refuses to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and this patch together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).
