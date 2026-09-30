#!/usr/bin/env node
/**
 * The Lanes extension as a .vsix, the file `code --install-extension` and
 * `code-server --install-extension` take.
 *
 *     node vscode/pack.mjs                      writes vscode/lanekit-<version>.vsix
 *     node vscode/pack.mjs --out /tmp/l.vsix    writes it there
 *
 * WHY NOT vsce. Microsoft's packer is an npm package with a tree of dependencies, and
 * lanekit has none and needs no build: a .vsix is a zip of the manifest and the files, with
 * two small XML files beside them. Node's zlib writes the zip.
 *
 * THE SAME BYTES EVERY TIME. Every entry is dated 1 January 1980 and written in one order,
 * so the same files make the same .vsix, and whoever installs it can tell from its hash
 * alone whether there is anything new to install.
 *
 * WHAT IS IN IT. Only vscode/extension.js and vscode/package.json, a README, and lanekit's
 * LICENSE: the extension finds lanekit's checkout on the machine and runs the rest from
 * there (extension.js says why).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const HERE = path.dirname(new URL(import.meta.url).pathname)

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()
const crc32 = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

// 1 January 1980, 00:00, in the DOS format a zip dates its entries in.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/** A zip of `[name, bytes]` entries, deflated, in the order given. */
export const zip = (entries) => {
    const locals = []
    const centrals = []
    let offset = 0
    for (const [name, content] of entries) {
        const nameBytes = Buffer.from(name, 'utf8')
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
        const packed = zlib.deflateRawSync(data, { level: 9 })
        const crc = crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)            // version needed
        local.writeUInt16LE(0x0800, 6)        // names are UTF-8
        local.writeUInt16LE(8, 8)             // deflated
        local.writeUInt16LE(DOS_TIME, 10)
        local.writeUInt16LE(DOS_DATE, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(packed.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBytes.length, 26)
        local.writeUInt16LE(0, 28)
        locals.push(local, nameBytes, packed)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)          // made by
        central.writeUInt16LE(20, 6)          // needed
        central.writeUInt16LE(0x0800, 8)
        central.writeUInt16LE(8, 10)
        central.writeUInt16LE(DOS_TIME, 12)
        central.writeUInt16LE(DOS_DATE, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(packed.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(nameBytes.length, 28)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, nameBytes)
        offset += local.length + nameBytes.length + packed.length
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, ...centrals, end])
}

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The .vsix's bytes, and what it is. */
export const build = () => {
    const manifestText = fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestText)
    const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Categories>${xml(manifest.categories.join(','))}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml(manifest.extensionKind.join(','))}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`
    const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`
    const readme = `# Lanes

Every lane of every repository in the folders open in this window, as a smartlog you act
on: open a commit's or a lane's changes as diffs, a lane in its own window or a terminal
in it, and gate, land and sweep it. **Lanes: Show** opens it; the status bar says which lane
the file in front of you is in, and what it needs.

It runs lanekit from the checkout on this machine (\`lanekit.path\`, else \`$LANEKIT\`, else
\`/opt/lanekit\`, else \`~/.lanekit\`). Apache License 2.0; the source is https://github.com/Oerba-Labs/lanekit.
`
    const bytes = zip([
        ['extension.vsixmanifest', vsixManifest],
        ['[Content_Types].xml', contentTypes],
        ['extension/package.json', manifestText],
        ['extension/extension.js', fs.readFileSync(path.join(HERE, 'extension.js'))],
        ['extension/README.md', readme],
        ['extension/LICENSE.txt', fs.readFileSync(path.join(HERE, '..', 'LICENSE'))]
    ])
    return { bytes, name: `${manifest.publisher}.${manifest.name}`, version: manifest.version, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
}

const main = (argv) => {
    const at = argv.indexOf('--out')
    const built = build()
    const out = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : path.join(HERE, `lanekit-${built.version}.vsix`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(`${out}.new`, built.bytes)
    fs.renameSync(`${out}.new`, out)
    console.log(`${out}\n${built.name} ${built.version}, sha256 ${built.sha256}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main(process.argv.slice(2))
