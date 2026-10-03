# Contributing to ShareGo

Thanks for helping improve ShareGo. Contributions should keep the app simple,
privacy-preserving, and usable on real devices over local networks.

## Before you start

ShareGo is a Next.js application. The signaling route introduces peers, but
file bytes are transferred directly between browsers over WebRTC DataChannels.
Please avoid changes that upload, store, or proxy file contents through the
server.

## Development setup

Requirements:

- Node.js 20 or newer
- A modern browser with WebRTC DataChannel support

Clone the repository, install dependencies, and start the development server:

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in a browser. To test with a phone or another
computer on the same network, open the development computer's LAN address
instead of `localhost`, for example `http://192.168.1.20:3000`.

## Making changes

1. Create a focused branch from the default branch.
2. Make the smallest complete change that addresses the issue.
3. Keep wire-boundary validation in the signaling and WebRTC protocol layers.
   Do not trust peer-supplied strings or send `File` handles over the wire.
4. Preserve the existing store and engine boundaries. React components should
   consume state through the existing hooks rather than reaching into the
   transport directly.
5. Update relevant documentation when behavior, configuration, or commands
   change.

## Verification

Run the repository checks before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run build
```

ShareGo does not currently have an automated test suite. For behavior changes,
manually verify the affected flow with two browser windows or two devices:

- Connect and disconnect peers, including accepting and rejecting requests.
- Confirm shared files appear without uploading them to the server.
- Test a small file and a larger file, including progress and completion.
- Preview supported media and close the preview to check that it releases
  resources.
- Add and remove a shared file and confirm the remote file list refreshes.
- Check the Settings activity log for connection and transfer errors.

When testing with two physical devices, use the host computer's LAN address.
If devices connect through different application instances in a deployment,
configure the Upstash Redis variables described in [.env.example](./.env.example).

## Pull requests

Pull requests should:

- Explain the user-visible change and why it is needed.
- Describe manual verification steps, including the browsers or devices used
  when relevant.
- Keep unrelated formatting or dependency changes out of the diff.
- Include screenshots or a short recording for meaningful UI changes.
- Call out known limitations or deployment requirements.

Please do not include secrets, private files, or captured file contents in a
commit, issue, or pull request.
