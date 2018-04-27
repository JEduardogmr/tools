(function() {

/**
 * A global map from a fully qualified module URLs to module objects.
 */
const registry: {[url: string]: Module} = Object.create(null);

/**
 * Return a module object from the registry for the given URL, creating one if
 * it doesn't exist yet.
 */
function getModule(url: string): Module {
  let mod = registry[url];
  if (mod === undefined) {
    mod = registry[url] = new Module(url);
  }
  return mod;
}

const anchor = document.createElement('a');

type normalizedUrl = string&{_normalized: never};

/**
 * Use the browser to resolve a URL to its canonical format.
 *
 * Examples:
 *
 *  - //example.com/ => http://example.com/
 *  - http://example.com => http://example.com/
 *  - http://example.com/foo/bar/../baz => http://example.com/foo/baz
 */
function normalizeUrl(url: string): normalizedUrl {
  anchor.href = url;
  return anchor.href as normalizedUrl;
}

/**
 * Examples:
 *
 *  - http://example.com/ => http://example.com/
 *  - http://example.com/foo.js => http://example.com/
 *  - http://example.com/foo/ => http://example.com/foo/
 *  - http://example.com/foo/?query#frag => http://example.com/foo/
 */
function getBasePath(url: normalizedUrl): normalizedUrl {
  url = url.substring(0, url.indexOf('?')) as normalizedUrl;
  url = url.substring(0, url.indexOf('#')) as normalizedUrl;
  // Normalization ensures we always have a trailing slash after a bare domain,
  // so this will always return with a trailing slash.
  return url.substring(0, url.lastIndexOf('/' + 1)) as normalizedUrl;
}

let pendingDefine: ((mod: Module) => void)|undefined = undefined;

class Module {
  private url: normalizedUrl;
  private urlBase: string;
  private exports: {[id: string]: {}} = {};

  /** All dependencies are resolved and the factory has run. */
  private resolved = false;

  /** Callbacks from dependents waiting for this module to resolve. */
  private notify: Array<() => void> = [];

  public needsLoad = true;

  constructor(url: string) {
    this.url = normalizeUrl(url);
    this.urlBase = getBasePath(this.url);
  }

  /**
   * Initialize this module with its dependencies and factory function. Note
   * that Module objects are created and registered before they are loaded,
   * which is why this is not simply part of construction.
   */
  define(deps: string[], factory?: (...args: {}[]) => void) {
    const mod = this;
    this.require(deps, function(...args: {}[]) {
      if (factory !== undefined) {
        factory.apply(null, args);
      }
      mod.resolved = true;
      for (const callback of mod.notify) {
        callback();
      }
    });
  }

  /**
   * Execute the given callback after all dependencies are resolved.
   */
  require(deps: string[], callback?: (...args: {}[]) => void) {
    const args: {}[] = [];
    let numUnresolvedDeps = 0;

    function onDepResolved() {
      numUnresolvedDeps--;
      checkDeps();
    }

    function checkDeps() {
      if (numUnresolvedDeps === 0) {
        if (callback !== undefined) {
          callback.apply(null, args);
        }
      }
    }

    for (let i = 0; i < deps.length; i++) {
      const depSpec = deps[i];

      if (depSpec === 'exports') {
        args[i] = this.exports;

      } else if (depSpec === 'require') {
        args[i] = this.require.bind(this);

      } else if (depSpec === 'meta') {
        // TODO(aomarks) Possibly replace with
        args[i] = {url: this.url};

      } else {
        const depMod = getModule(this.resolveUrl(depSpec));
        args[i] = depMod.exports;

        if (depMod.resolved === false) {
          numUnresolvedDeps++;
          depMod.notify.push(onDepResolved);
          depMod.loadIfNeeded();
        }
      }
    }

    checkDeps();
  }

  /**
   * Resolve a URL relative to the URL of this module.
   */
  private resolveUrl(url: string) {
    if (url.indexOf('://') !== -1) {
      // Already a fully qualified URL.
      return url;
    }
    return normalizeUrl(this.urlBase + url);
  }

  /**
   * Load this module by creating a <script> tag in the document <head>, unless
   * we have already started (or didn't need to, as in the case of top-level
   * scripts).
   */
  private loadIfNeeded() {
    if (this.needsLoad === false) {
      return;
    }
    this.needsLoad = true;

    const script = document.createElement('script');
    script.src = this.url;

    const mod = this;
    script.onload = function() {
      if (pendingDefine !== undefined) {
        pendingDefine(mod);
      } else {
        // The script did not make a call to define(), otherwise the global
        // callback would have been set. That's fine, we can resolve immediately
        // because we don't have any dependencies, by definition.
        mod.define([]);
      }
    };

    script.onerror = function() {
      throw new Error('error loading module ' + mod.url);
    };

    document.head.appendChild(script);
  }
}

let topLevelScriptIdx = 0;
let previousTopLevelUrl: string|undefined = undefined;

/**
 * Define a module and execute its factory function when all dependencies are
 * resolved.
 *
 * Dependencies must be specified as URLs, either relative or fully qualified
 * (e.g. "../foo.js" or "http://example.com/bar.js" but not "my-module-name").
 */
window.define = function(deps: string[], factory?: (...args: {}[]) => void) {
  // We don't yet know our own module URL. We need to discover it so that we
  // can resolve our relative dependency specifiers. There are two ways the
  // script executing this define() call could have been loaded:

  // Case #1: We are a dependency of another module. A <script> was injected
  // to load us, but we don't yet know the URL that was used. Because
  // document.currentScript is not supported by IE, we communicate the URL via
  // a global callback. When finished executing, the "onload" event will be
  // fired by this <script>, which will be handled by the loading script,
  // which will invoke the callback with our module object.
  let defined = false;
  pendingDefine = function(mod) {
    defined = true;
    pendingDefine = undefined;
    mod.define(deps, factory);
  };

  // Case #2: We are a top-level script in the HTML document. Our URL is the
  // document's base URL. We can discover this case by waiting a tick, and if
  // we haven't already been defined by the "onload" handler from case #1,
  // then this must be case #2.
  setTimeout(function() {
    if (defined === false) {
      const url = document.baseURI + '#' + topLevelScriptIdx++;
      const mod = getModule(url);

      // Top-level scripts are already loaded.
      mod.needsLoad = false;

      if (previousTopLevelUrl !== undefined) {
        // type=module scripts execute in order (with the same timing as defer
        // scripts). Because this is a top-level script, and we are trying to
        // mirror type=module behavior as much as possible, inject a
        // dependency on the previous top-level script to preserve the
        // relative ordering.
        deps.push(previousTopLevelUrl);
      }
      previousTopLevelUrl = url;
      mod.define(deps, factory);
    }
  }, 0);
};
})();

interface Window {
  define: (deps: string[], factory: (...args: {}[]) => void) => void;
}
