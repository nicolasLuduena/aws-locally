<img src="assets/icon.svg" width="64" height="64" alt="">

# aws-locally

A hands-on, DevOps-level AWS course that runs entirely on your machine against
[AWS Emulator](https://github.com/aws/aws-emulator), AWS's official local
emulator of its APIs. There's no AWS account and no bill, and the course
terminal can't touch real AWS.

You get a browser UI with:

- **15 modules**, from how AWS works through IAM, VPC, compute, storage,
  databases, messaging, serverless, containers, security, observability,
  CloudFormation, Terraform and CI/CD, ending in a capstone.
- **A real terminal** (bash in a PTY) wired to the emulator. Every code
  snippet in the lessons has a **▶ Run** button that types it there.
- **An API inspector** that shows every signed HTTP call the CLI, Terraform or
  an SDK makes: service, operation, protocol, status, error code, headers and bodies.
- **A resource console** (the emulator has no GUI), including a live VPC
  topology map. It refreshes after every write you make.
- **Auto-graded labs**: *Check my work* inspects the emulator's actual state
  and tells you exactly what's still wrong. Hints and reference solutions included.
- **Quizzes** with scenario questions and explanations. Progress is saved in `.state/`.

## Quick start

```bash
npm run setup   # downloads AWS Emulator, AWS CLI v2 and Terraform into .tools/ (no sudo)
npm start       # builds the UI and serves it at http://127.0.0.1:4380
```

Requirements: Node 22.18+ (it runs the TypeScript server directly), Python 3,
`curl`, `unzip`, `zip` and `jq`. On Linux (x86_64 or aarch64) the emulator runs
natively. On macOS and Windows (WSL), `npm run setup` builds the `aws-emulator`
Docker image from AWS's Dockerfile and the server runs it in Docker.

`npm run dev` serves the UI with hot reload instead.

## How it fits together

```text
browser ──ws/http──▶ course server :4380 ──spawns──▶ aws-emulator :9297 (HTTPS, in-memory)
                         │  ├─ bash PTY (the Terminal tab)        ▲
                         │  └─ inspector proxy :9298 ─────────────┘  (the terminal's AWS_ENDPOINT_URL)
                         └─ lab checks & resource console → aws CLI → emulator directly
```

- **Reset state** in the top bar restarts the emulator. It keeps everything in
  memory, so that wipes every resource. Each lab has **Prepare lab**, which
  recreates its prerequisites, so resetting is always safe.
- Ports can be changed with `UI_PORT`, `EMU_PORT` and `PROXY_PORT`.
- To use the emulator from your own shell, see the *Your lab environment*
  lesson, or run a one-off command against a throwaway emulator:
  `scripts/with-emulator.sh aws s3 ls`.

## Course content

Modules live in `course/modules/*.ts` (schema: `course/types.ts`, style guide:
`course/AUTHORING.md`). Each lab ships with a reference solution, and
`npm run verify` proves every lab is solvable. For each lab it starts a fresh
emulator, runs the setup, confirms the checks fail, runs the solution and
confirms every check passes:

```bash
npm run verify                    # all labs
npm run verify -- serverless      # one module
npm run verify -- -j 6 -v vpc     # parallel, verbose
```

The emulator's fidelity is high but not perfect. The labs are designed around
the behaviour verified with v1.0.385, and the lessons call out where real AWS
differs (for example, EC2 instances get IDs, IPs and states but no VM boots).

## Contributing

Issues and pull requests are welcome, especially new labs and fixes for
emulator behaviour changes. Read `course/AUTHORING.md` first. Every lab needs a
reference solution that passes `npm run verify`.

## Security notes

The server listens on 127.0.0.1 only. API and WebSocket calls need a
per-process session token, and the server checks the Host and Origin headers, so
other web pages can't drive the terminal. The course shell strips every
`AWS_*` variable from your environment and doesn't load your `~/.bashrc`.
Emulator telemetry is turned off.

## License and disclaimer

MIT. See [LICENSE](LICENSE).

This is an independent project. It is not affiliated with, endorsed by or
sponsored by Amazon Web Services. AWS and the names of AWS services are
trademarks of Amazon.com, Inc. or its affiliates. AWS Emulator is downloaded
from AWS by `npm run setup` under its own license and isn't redistributed here.
