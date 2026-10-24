// Application-private PGlite filesystem. SQLite supplies atomic commits and
// crash recovery; AES-256-GCM protects each database page at rest.
import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BaseFilesystem,
  ERRNO_CODES,
} from "./node_modules/@electric-sql/pglite/dist/fs/base.js";

const PAGE = 8192;
const FORMAT = "factory-pglite-pages-v1";
const err = (code, message) => Object.assign(new Error(message), { code });
const directory = (node) => (node.mode & 0o170000) === 0o040000;

export class EncryptedFS extends BaseFilesystem {
  constructor(
    filename,
    key,
    { create = false, cacheBytes = 16 * 1024 * 1024 } = {},
  ) {
    super();
    if (!(key instanceof Uint8Array) || key.length !== 32)
      throw new Error("A 256-bit key is required");
    if (!create && !fs.existsSync(filename))
      throw new Error(
        "Encrypted page store is missing; refusing an empty database",
      );
    this.key = Buffer.from(key);
    this.cacheLimit = Math.floor(cacheBytes / PAGE);
    this.cache = new Map();
    this.handles = new Map();
    this.nextFd = 10;
    this.pending = false;
    this.poisoned = false;
    this.closed = false;
    this.stats = {
      commits: 0,
      encryptedBytes: 0,
      decryptedBytes: 0,
      cachePages: 0,
    };
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.sql = new Database(filename, { create, strict: true });
    fs.chmodSync(filename, 0o600);
    try {
      this.sql.exec(
        "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; PRAGMA cache_size=-16384; PRAGMA wal_autocheckpoint=1000;",
      );
      // The exclusive SQLite connection lock outlives individual transactions.
      // A second PGlite instance must not open the same filesystem concurrently.
      this.sql.exec("BEGIN EXCLUSIVE; COMMIT;");
      if (create)
        this.sql.exec(`
        CREATE TABLE IF NOT EXISTS format (name TEXT PRIMARY KEY, proof BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS nodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE, mode INTEGER NOT NULL,
          size INTEGER NOT NULL, atime INTEGER NOT NULL, mtime INTEGER NOT NULL, ctime INTEGER NOT NULL,
          mac BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pages (
          inode INTEGER NOT NULL, number INTEGER NOT NULL, ciphertext BLOB NOT NULL,
          PRIMARY KEY(inode, number)
        ) WITHOUT ROWID;
      `);
      const proof = this.mac(FORMAT);
      const stored = this.sql
        .query("SELECT proof FROM format WHERE name=?")
        .get(FORMAT);
      if (!stored) {
        if (!create)
          throw new Error("Encrypted page store has no format proof");
        this.sql.query("INSERT INTO format VALUES (?, ?)").run(FORMAT, proof);
      } else if (!this.equal(stored.proof, proof))
        throw new Error("Encrypted page-store key verification failed");
      this.q = {
        node: this.sql.query("SELECT * FROM nodes WHERE path=?"),
        inode: this.sql.query("SELECT * FROM nodes WHERE id=?"),
        page: this.sql.query(
          "SELECT ciphertext FROM pages WHERE inode=? AND number=?",
        ),
        putPage: this.sql.query(
          "INSERT INTO pages VALUES (?, ?, ?) ON CONFLICT(inode, number) DO UPDATE SET ciphertext=excluded.ciphertext",
        ),
        update: this.sql.query(
          "UPDATE nodes SET path=?,mode=?,size=?,atime=?,mtime=?,ctime=?,mac=? WHERE id=?",
        ),
      };
      if (!this.q.node.get("/")) {
        if (!create) throw new Error("Encrypted filesystem root is missing");
        this.addNode("/", 0o40700);
      }
      // No descriptors survive a process restart. Unlinked inodes are garbage.
      this.begin();
      this.sql.exec(
        "DELETE FROM pages WHERE inode IN (SELECT id FROM nodes WHERE path IS NULL); DELETE FROM nodes WHERE path IS NULL;",
      );
      this.commit();
    } catch (error) {
      this.sql.close();
      this.key.fill(0);
      throw error;
    }
  }

  equal(a, b) {
    return a.length === b.length && timingSafeEqual(a, b);
  }
  mac(value) {
    return createHmac("sha256", this.key).update(value).digest();
  }
  nodeMac(n) {
    return this.mac(
      JSON.stringify([
        FORMAT,
        n.id,
        n.path,
        n.mode,
        n.size,
        n.atime,
        n.mtime,
        n.ctime,
      ]),
    );
  }
  verify(n) {
    if (!n) throw err(ERRNO_CODES.ENOENT, "File not found");
    if (!this.equal(n.mac, this.nodeMac(n)))
      throw new Error("Encrypted filesystem metadata authentication failed");
    return n;
  }
  check() {
    if (this.closed || this.poisoned)
      throw new Error("Encrypted filesystem is closed or failed");
  }
  normalize(value) {
    this.check();
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.split("/").includes("..")
    )
      throw err(ERRNO_CODES.EINVAL, "Invalid filesystem path");
    return path.posix.normalize("/" + value);
  }
  node(value) {
    this.check();
    return this.verify(this.q.node.get(this.normalize(value)));
  }
  inode(id) {
    this.check();
    return this.verify(this.q.inode.get(id));
  }
  begin() {
    this.check();
    if (!this.pending) {
      this.sql.exec("BEGIN IMMEDIATE");
      this.pending = true;
    }
  }
  commit() {
    this.check();
    if (!this.pending) return;
    try {
      this.sql.exec("COMMIT");
      this.pending = false;
      this.stats.commits++;
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
  save(n) {
    this.begin();
    this.q.update.run(
      n.path,
      n.mode,
      n.size,
      n.atime,
      n.mtime,
      n.ctime,
      this.nodeMac(n),
      n.id,
    );
  }
  addNode(name, mode) {
    this.begin();
    const time = Date.now();
    const r = this.sql
      .query(
        "INSERT INTO nodes(path,mode,size,atime,mtime,ctime,mac) VALUES (?,?,0,?,?,?,?)",
      )
      .run(name, mode, time, time, time, Buffer.alloc(0));
    const n = {
      id: Number(r.lastInsertRowid),
      path: name,
      mode,
      size: 0,
      atime: time,
      mtime: time,
      ctime: time,
    };
    this.save(n);
    return n;
  }
  parent(name) {
    const n = this.node(path.posix.dirname(name));
    if (!directory(n))
      throw err(ERRNO_CODES.ENOTDIR, "Parent is not a directory");
  }
  toStat(n) {
    return {
      dev: 0,
      ino: n.id,
      mode: n.mode,
      nlink: n.path === null ? 0 : 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: n.size,
      blksize: PAGE,
      blocks: Math.ceil(n.size / 512),
      atime: n.atime,
      mtime: n.mtime,
      ctime: n.ctime,
    };
  }
  lstat(name) {
    return this.toStat(this.node(name));
  }
  fstat(fd) {
    return this.toStat(this.inode(this.handle(fd).inode));
  }
  handle(fd) {
    this.check();
    const h = this.handles.get(fd);
    if (!h) throw err(ERRNO_CODES.EBADF, "Bad descriptor");
    return h;
  }
  chmod(name, mode) {
    const n = this.node(name);
    n.mode = (n.mode & 0o170000) | (mode & 0o7777);
    n.ctime = Date.now();
    this.save(n);
  }
  utimes(name, atime, mtime) {
    const n = this.node(name);
    n.atime = Math.round(atime);
    n.mtime = Math.round(mtime);
    this.save(n);
  }
  mkdir(name, options = {}) {
    name = this.normalize(name);
    if (this.q.node.get(name)) {
      if (options.recursive && directory(this.node(name))) return;
      throw err(ERRNO_CODES.EEXIST, "Path exists");
    }
    if (options.recursive && name !== "/") {
      const parent = path.posix.dirname(name);
      if (!this.q.node.get(parent)) this.mkdir(parent, options);
    }
    this.parent(name);
    this.addNode(name, 0o40000 | (options.mode ?? 0o700));
  }
  readdir(name) {
    const n = this.node(name);
    if (!directory(n)) throw err(ERRNO_CODES.ENOTDIR, "Not a directory");
    return this.sql
      .query("SELECT * FROM nodes WHERE path IS NOT NULL")
      .all()
      .map((row) => this.verify(row).path)
      .filter((p) => p !== n.path && path.posix.dirname(p) === n.path)
      .map((p) => path.posix.basename(p));
  }
  // PGlite 0.3.16's custom-FS bridge omits flags; its outer FS enforces access.
  open(name, flags = "r+", mode = 0o600) {
    name = this.normalize(name);
    if (
      !["r", "r+", "w", "w+", "a", "a+", "wx", "wx+", "ax", "ax+"].includes(
        flags,
      )
    )
      throw err(ERRNO_CODES.EINVAL, "Unsupported open flags");
    const exists = this.q.node.get(name);
    if (exists && flags.includes("x"))
      throw err(ERRNO_CODES.EEXIST, "Path exists");
    let n;
    if (exists) n = this.verify(exists);
    else {
      if (flags.startsWith("r"))
        throw err(ERRNO_CODES.ENOENT, "File not found");
      this.parent(name);
      n = this.addNode(name, 0o100000 | mode);
    }
    if (directory(n)) throw err(ERRNO_CODES.EISDIR, "Cannot open a directory");
    if (flags.startsWith("w")) {
      this.resize(n, 0);
      n = this.inode(n.id);
    }
    const fd = this.nextFd++;
    this.handles.set(fd, {
      inode: n.id,
      writable: flags !== "r",
      append: flags.startsWith("a"),
    });
    return fd;
  }
  close(fd) {
    const h = this.handle(fd);
    this.handles.delete(fd);
    const n = this.inode(h.inode);
    if (
      n.path === null &&
      ![...this.handles.values()].some((x) => x.inode === n.id)
    )
      this.removeInode(n.id);
  }
  aad(id, page) {
    return Buffer.from(`${FORMAT}:${id}:${page}`);
  }
  remember(id, page, data) {
    if (this.cacheLimit < 1) return;
    const k = `${id}:${page}`;
    this.cache.delete(k);
    this.cache.set(k, data);
    while (this.cache.size > this.cacheLimit)
      this.cache.delete(this.cache.keys().next().value);
    this.stats.cachePages = this.cache.size;
  }
  getPage(id, page) {
    this.check();
    const k = `${id}:${page}`;
    const cached = this.cache.get(k);
    if (cached) {
      this.remember(id, page, cached);
      return cached;
    }
    const row = this.q.page.get(id, page);
    if (!row || row.ciphertext.length !== PAGE + 28)
      throw new Error("Encrypted filesystem page is missing or truncated");
    const value = Buffer.from(row.ciphertext);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(0, 12),
    );
    decipher.setAAD(this.aad(id, page));
    decipher.setAuthTag(value.subarray(12, 28));
    const data = Buffer.concat([
      decipher.update(value.subarray(28)),
      decipher.final(),
    ]);
    this.stats.decryptedBytes += data.length;
    this.remember(id, page, data);
    return data;
  }
  putPage(id, page, data) {
    this.begin();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad(id, page));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const value = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    this.q.putPage.run(id, page, value);
    this.stats.encryptedBytes += value.length;
    this.remember(id, page, Buffer.from(data));
  }
  resize(n, size) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw err(ERRNO_CODES.EINVAL, "Invalid file size");
    this.begin();
    const oldPages = Math.ceil(n.size / PAGE),
      newPages = Math.ceil(size / PAGE);
    if (size < n.size) {
      this.sql
        .query("DELETE FROM pages WHERE inode=? AND number>=?")
        .run(n.id, newPages);
      for (const k of this.cache.keys())
        if (k.startsWith(`${n.id}:`) && Number(k.split(":")[1]) >= newPages)
          this.cache.delete(k);
      if (size % PAGE) {
        const data = Buffer.from(this.getPage(n.id, newPages - 1));
        data.fill(0, size % PAGE);
        this.putPage(n.id, newPages - 1, data);
      }
    } else
      for (let p = oldPages; p < newPages; p++)
        this.putPage(n.id, p, Buffer.alloc(PAGE));
    n.size = size;
    n.mtime = n.ctime = Date.now();
    this.save(n);
  }
  truncate(name, size = 0) {
    const n = this.node(name);
    if (directory(n))
      throw err(ERRNO_CODES.EISDIR, "Cannot truncate directory");
    this.resize(n, size);
  }
  read(fd, buffer, offset, length, position) {
    const n = this.inode(this.handle(fd).inode);
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.length
    )
      throw err(ERRNO_CODES.EINVAL, "Invalid read range");
    const count = Math.max(0, Math.min(length, n.size - position));
    for (let done = 0; done < count; ) {
      const at = position + done,
        page = Math.floor(at / PAGE),
        within = at % PAGE;
      const take = Math.min(PAGE - within, count - done);
      buffer.set(
        this.getPage(n.id, page).subarray(within, within + take),
        offset + done,
      );
      done += take;
    }
    return count;
  }
  write(fd, buffer, offset, length, position) {
    // This PGlite bridge passes HEAP.buffer, despite its Uint8Array annotation.
    if (buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)
      buffer = new Uint8Array(buffer);
    const h = this.handle(fd);
    if (!h.writable) throw err(ERRNO_CODES.EBADF, "Descriptor is not writable");
    const n = this.inode(h.inode);
    if (h.append) position = n.size;
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.length
    )
      throw err(ERRNO_CODES.EINVAL, "Invalid write range");
    if (length === 0) return 0;
    if (position + length > n.size) this.resize(n, position + length);
    for (let done = 0; done < length; ) {
      const at = position + done,
        page = Math.floor(at / PAGE),
        within = at % PAGE;
      const take = Math.min(PAGE - within, length - done);
      const data =
        within === 0 && take === PAGE
          ? Buffer.from(buffer.subarray(offset + done, offset + done + take))
          : Buffer.from(this.getPage(n.id, page));
      if (within !== 0 || take !== PAGE)
        data.set(buffer.subarray(offset + done, offset + done + take), within);
      this.putPage(n.id, page, data);
      done += take;
    }
    n.mtime = n.ctime = Date.now();
    this.save(n);
    return length;
  }
  writeFile(name, value, options = {}) {
    const data =
      typeof value === "string"
        ? Buffer.from(value, options.encoding ?? "utf8")
        : value;
    const fd = this.open(name, options.flag ?? "w", options.mode ?? 0o600);
    try {
      this.write(fd, data, 0, data.length, 0);
    } finally {
      this.close(fd);
    }
  }
  removeInode(id) {
    this.begin();
    this.sql.query("DELETE FROM pages WHERE inode=?").run(id);
    this.sql.query("DELETE FROM nodes WHERE id=?").run(id);
    for (const k of this.cache.keys())
      if (k.startsWith(`${id}:`)) this.cache.delete(k);
  }
  unlink(name) {
    const n = this.node(name);
    if (directory(n)) throw err(ERRNO_CODES.EISDIR, "Cannot unlink directory");
    if ([...this.handles.values()].some((h) => h.inode === n.id)) {
      n.path = null;
      this.save(n);
    } else this.removeInode(n.id);
  }
  rmdir(name) {
    const n = this.node(name);
    if (n.path === "/" || this.readdir(name).length)
      throw err(ERRNO_CODES.ENOTEMPTY, "Directory is not empty");
    this.removeInode(n.id);
  }
  rename(from, to) {
    const n = this.node(from);
    to = this.normalize(to);
    this.parent(to);
    if (n.path === to) return;
    if (n.path === "/" || to.startsWith(n.path + "/"))
      throw err(ERRNO_CODES.EINVAL, "Invalid rename");
    const target = this.q.node.get(to);
    if (target) {
      const t = this.verify(target);
      if (directory(n) !== directory(t))
        throw err(ERRNO_CODES.EINVAL, "Rename type mismatch");
      if (directory(t)) this.rmdir(to);
      else this.unlink(to);
    }
    const prefix = n.path;
    if (directory(n))
      for (const row of this.sql
        .query("SELECT * FROM nodes WHERE path IS NOT NULL")
        .all()) {
        if (row.path.startsWith(prefix + "/")) {
          const child = this.verify(row);
          child.path = to + child.path.slice(prefix.length);
          this.save(child);
        }
      }
    n.path = to;
    this.save(n);
  }
  async syncToFs() {
    this.commit();
  }
  async initialSyncFs() {}
  checkpoint() {
    this.commit();
    this.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  shutdown() {
    if (this.closed) return;
    if (!this.poisoned) {
      this.commit();
      this.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    this.sql.close();
    this.cache.clear();
    this.key.fill(0);
    this.closed = true;
  }
  async closeFs() {
    this.pg?.Module.FS.quit();
    this.shutdown();
  }
}

export const pageSize = PAGE;
