const fs = require("fs");
const util = require("util");
const os = require("os");
const path = require("path");

const {
  parse,
  toSeratoString,
  intToHexbin,
  sanitizeFilename,
  removeDriveRoot,
  selectExternalRoot,
  isFromExternalDrive,
} = require("./util");

// Singleton for Serato Folder Path (I doubt it'll change during runtime)
const PLATFORM_DEFAULT_SERATO_FOLDER = path.join(
  os.homedir(),
  "Music",
  "_Serato_"
);

function getSubcratesFolder(seratoFolder) {
  return path.join(seratoFolder, "SubCrates");
}

function getSmartcratesFolder(seratoFolder) {
  return path.join(seratoFolder, "SmartCrates");
}

/** Checks if the default platform folder for serato is available. */
function isDefaultSeratoFolderPresent() { 
  return fs.existsSync(PLATFORM_DEFAULT_SERATO_FOLDER);
}

/**
 * For each Serato Folder location, collect crates and returns a list
 * of all of these.
 */
function listCratesSync(seratoFolders = [PLATFORM_DEFAULT_SERATO_FOLDER]) {
  const allCrates = [];
  seratoFolders.forEach((seratoFolder) => {
    const subcratesFolder = getSubcratesFolder(seratoFolder);

    // Make sure the folder existsts
    if(fs.existsSync(subcratesFolder) === false) {
      return;
    }

    const crates = fs.readdirSync(subcratesFolder).map((x) => {
      const name = path.basename(x, ".crate");
      return new Crate(name, seratoFolder);
    });
    allCrates.push(...crates);
    const smartcratesFolder = getSmartcratesFolder(seratoFolder);

    // Make sure the folder existsts
    if(fs.existsSync(smartcratesFolder) === false) {
      return;
    }
    
    const smartcrates = fs.readdirSync(smartcratesFolder).map((x) => {
      const name = path.basename(x, ".crate");
      return new Crate(name, seratoFolder, true);
    });
    allCrates.push(...smartcrates);
  });
  return allCrates;
}

async function listCrates(seratoFolders = [PLATFORM_DEFAULT_SERATO_FOLDER]) {
  const allCrates = [];
  for (const seratoFolder of seratoFolders) {
    const subcratesFolder = getSubcratesFolder(seratoFolder);

    // Make sure the folder existsts
    if(fs.existsSync(subcratesFolder) === false) {
      continue;
    }

    const files = await util.promisify(fs.readdir)(subcratesFolder);
    const crates = files.map((x) => {
      const name = path.basename(x, ".crate");
      return new Crate(name, seratoFolder);
    });
    allCrates.push(...crates);
  }
  return allCrates;
}

class Crate {
  /**
   * Serato saves crates in all the drives from which songs
   * in the crate come from. When you create a seratojs.Crate
   * it assumes we are dealing with a Music-folder-main-drive crate.
   *
   * You can "fix" this crate to represent a particular crate in
   * one particular Serato folder; in which case saving will use
   * that location only. You are responsible for adding songs
   * compatible with that drive. This is what we call 'location-aware'
   * crates.
   */
  constructor(name, seratoFolder, isSmart = false) {
    // TODO: Make private
    this.name = sanitizeFilename(name);
    this.filename = isSmart ? this.name + ".scrate" : this.name.replace("-scrate", "") + ".crate";
    this.songPaths = [];
    this.isSmart = isSmart

    this.seratoFolder = seratoFolder; // To override for testing...
  }

  /**
   * Returns the Serato directories where this will be saved.
   */
  getSaveLocations() {
    if (this.seratoFolder) {
      return [this.seratoFolder]; // if specified at construction use this only.
    }

    if (this.songPaths.length === 0) {
      return [PLATFORM_DEFAULT_SERATO_FOLDER];
    }

    const roots = new Set();
    this.songPaths.forEach((songPath) => {
      if (isFromExternalDrive(songPath)) {
        const externalRoot = selectExternalRoot(songPath);
        roots.add(path.join(externalRoot, "_Serato_"));
      } else {
        roots.add(PLATFORM_DEFAULT_SERATO_FOLDER);
      }
    });
    return Array.from(roots);
  }

  getSongFileBufferSync () {
    const filepath = this._buildCrateFilepath(
      this.seratoFolder || PLATFORM_DEFAULT_SERATO_FOLDER
    );

    if (fs.existsSync(filepath) === false) {
      return [];
    }
    return fs.readFileSync(filepath);
  }

  // TODO: When reading, where should it read from?
  async getSongPaths() {
    const filepath = this._buildCrateFilepath(
      this.seratoFolder || PLATFORM_DEFAULT_SERATO_FOLDER
    );

    if (fs.existsSync(filepath) === false) {
      return [];
    }

    const contents = await util.promisify(fs.readFile)(filepath, "ascii");
    return parse(contents);
  }
  getSongPathsSync() {
    const filepath = this._buildCrateFilepath(
      this.seratoFolder || PLATFORM_DEFAULT_SERATO_FOLDER, this.isSmart
    );

    if (fs.existsSync(filepath) === false) {
      return [];
    }

    const contents = fs.readFileSync(filepath, "ascii");
    return parse(contents);
  }

  addSong(songPath) {
    if (this.songPaths === null) {
      this.songPaths = [];
    }

    const resolved = path.resolve(songPath);
    this.songPaths.push(resolved);
  }

  _buildCrateFilepath(seratoFolder) {
    const subcrateFolder = this.isSmart ? getSmartcratesFolder(seratoFolder) : getSubcratesFolder(seratoFolder);
    let filepath = '';
    if (this.isSmart) {
      filepath = path.join(subcrateFolder, this.filename.replace('-scrate', '').replaceAll('--', '≫≫'));
    } else {
      filepath = path.join(subcrateFolder, this.filename.replaceAll('--', '%%'));
    }
    return filepath;
  }
  _buildSaveBuffer() {
    const header =
      "vrsn   8 1 . 0 / S e r a t o   S c r a t c h L i v e   C r a t e".replace(
        / /g,
        "\0"
      );

    let playlistSection = "";
    if (this.songPaths) {
      this.songPaths.forEach((songPath) => {
        const absoluteSongPath = path.resolve(songPath);
        const songPathWithoutDrive = removeDriveRoot(absoluteSongPath);
        const data = toSeratoString(songPathWithoutDrive);
        let ptrkSize = intToHexbin(data.length);
        let otrkSize = intToHexbin(data.length + 8); // fixing the +8 (4 for 'ptrk', 4 for ptrkSize)
        playlistSection += "otrk" + otrkSize + "ptrk" + ptrkSize + data;
      });
    }

    const contents = header + playlistSection;
    return Buffer.from(contents, "ascii");
  }

  async save() {
    for (const seratoFolder of this.getSaveLocations()) {
      const filepath = this._buildCrateFilepath(seratoFolder);
      const buffer = this._buildSaveBuffer();

      return util.promisify(fs.writeFile)(filepath, buffer, {
        encoding: null,
      });
    }
  }
  saveSync() {
    for (const seratoFolder of this.getSaveLocations()) {
      const filepath = this._buildCrateFilepath(seratoFolder);
      const buffer = this._buildSaveBuffer();

      // Ensure folder exists
      fs.writeFileSync(filepath, buffer, { encoding: null });
    }
  }
}

const seratojs = {
  Crate: Crate,
  listCratesSync: listCratesSync,
  listCrates: listCrates,
  isDefaultSeratoFolderPresent: isDefaultSeratoFolderPresent
};

module.exports = seratojs;
