# Third-party notices

T001 uses the following development tools. All are pinned in `package.json` and
their exact resolved versions and integrity values are recorded in `package-lock.json`.

| Component     | Version | License      | Purpose                                                                 |
| ------------- | ------- | ------------ | ----------------------------------------------------------------------- |
| Node.js       | 24.16.0 | MIT          | Local runtime; includes `node:sqlite` used by the trusted fixture store |
| npm           | 11.13.0 | Artistic-2.0 | Workspace package manager bundled with the tested Node runtime          |
| TypeScript    | 5.9.3   | Apache-2.0   | Type checking and JavaScript build output                               |
| Prettier      | 3.6.2   | MIT          | Source and documentation formatter                                      |
| `@types/node` | 24.10.0 | MIT          | Type declarations for the tested Node APIs                              |

The qdroid source in this repository remains licensed under Apache-2.0. This
fixture has no vendor SDK, robot software, account connector, model client, or
sandbox runtime dependency.

T002's fixed Linux reference image copies Node's upstream `/usr/local/LICENSE`
to `/usr/share/licenses/node/LICENSE`. The pinned Node 24.16.0 image provides
the Node and bundled-third-party license text; its source-image license file is
156,926 bytes with SHA-256
`4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18`.
