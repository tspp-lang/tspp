load as file with relative name in current directory
Resolving "./foo" from /foo/bar/baz.ts when module has extension: .tspp
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/bar/foo.ts",
    "/foo/bar/foo.tsx",
    "/foo/bar/foo.d.ts",
    "/foo/bar/foo.js",
    "/foo/bar/foo.jsx",
    "/foo/bar/foo/package.json",
    "/foo/bar/foo/index.ts",
    "/foo/bar/foo/index.tsx",
    "/foo/bar/foo/index.d.ts",
    "/foo/bar/foo/index.js",
    "/foo/bar/foo/index.jsx"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .tspp with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/bar/foo.ts",
    "/foo/bar/foo.tsx",
    "/foo/bar/foo.d.ts",
    "/foo/bar/foo.js",
    "/foo/bar/foo.jsx",
    "/foo/bar/foo/package.json",
    "/foo/bar/foo/index.ts",
    "/foo/bar/foo/index.tsx",
    "/foo/bar/foo/index.d.ts",
    "/foo/bar/foo/index.js",
    "/foo/bar/foo/index.jsx"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .d.tspp
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/bar/foo.ts",
    "/foo/bar/foo.tsx",
    "/foo/bar/foo.d.ts",
    "/foo/bar/foo.js",
    "/foo/bar/foo.jsx",
    "/foo/bar/foo/package.json",
    "/foo/bar/foo/index.ts",
    "/foo/bar/foo/index.tsx",
    "/foo/bar/foo/index.d.ts",
    "/foo/bar/foo/index.js",
    "/foo/bar/foo/index.jsx"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .d.tspp with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/bar/foo.ts",
    "/foo/bar/foo.tsx",
    "/foo/bar/foo.d.ts",
    "/foo/bar/foo.js",
    "/foo/bar/foo.jsx",
    "/foo/bar/foo/package.json",
    "/foo/bar/foo/index.ts",
    "/foo/bar/foo/index.tsx",
    "/foo/bar/foo/index.d.ts",
    "/foo/bar/foo/index.js",
    "/foo/bar/foo/index.jsx"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .ts
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/bar/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .ts with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/bar/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .tsx
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/bar/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/bar/foo.ts"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .tsx with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/bar/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/bar/foo.ts"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .d.ts
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/bar/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/bar/foo.ts",
    "/foo/bar/foo.tsx"
  ]
}

Resolving "./foo" from /foo/bar/baz.ts when module has extension: .d.ts with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/bar/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/bar/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/bar/foo.ts",
    "/foo/bar/foo.tsx"
  ]
}


load as file with relative name in parent directory
Resolving "../foo" from /foo/bar/baz.ts when module has extension: .tspp
//// [/foo/bar/baz.ts]


//// [/foo/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/foo.ts",
    "/foo/foo.tsx",
    "/foo/foo.d.ts",
    "/foo/foo.js",
    "/foo/foo.jsx",
    "/foo/foo/package.json",
    "/foo/foo/index.ts",
    "/foo/foo/index.tsx",
    "/foo/foo/index.d.ts",
    "/foo/foo/index.js",
    "/foo/foo/index.jsx"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .tspp with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/foo.ts",
    "/foo/foo.tsx",
    "/foo/foo.d.ts",
    "/foo/foo.js",
    "/foo/foo.jsx",
    "/foo/foo/package.json",
    "/foo/foo/index.ts",
    "/foo/foo/index.tsx",
    "/foo/foo/index.d.ts",
    "/foo/foo/index.js",
    "/foo/foo/index.jsx"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .d.tspp
//// [/foo/bar/baz.ts]


//// [/foo/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/foo.ts",
    "/foo/foo.tsx",
    "/foo/foo.d.ts",
    "/foo/foo.js",
    "/foo/foo.jsx",
    "/foo/foo/package.json",
    "/foo/foo/index.ts",
    "/foo/foo/index.tsx",
    "/foo/foo/index.d.ts",
    "/foo/foo/index.js",
    "/foo/foo/index.jsx"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .d.tspp with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo/foo.ts",
    "/foo/foo.tsx",
    "/foo/foo.d.ts",
    "/foo/foo.js",
    "/foo/foo.jsx",
    "/foo/foo/package.json",
    "/foo/foo/index.ts",
    "/foo/foo/index.tsx",
    "/foo/foo/index.d.ts",
    "/foo/foo/index.js",
    "/foo/foo/index.jsx"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .ts
//// [/foo/bar/baz.ts]


//// [/foo/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .ts with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .tsx
//// [/foo/bar/baz.ts]


//// [/foo/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/foo.ts"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .tsx with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/foo.ts"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .d.ts
//// [/foo/bar/baz.ts]


//// [/foo/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/foo.ts",
    "/foo/foo.tsx"
  ]
}

Resolving "../foo" from /foo/bar/baz.ts when module has extension: .d.ts with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo/foo.ts",
    "/foo/foo.tsx"
  ]
}


load as file with name starting with directory seperator
Resolving "/foo" from /foo/bar/baz.ts when module has extension: .tspp
//// [/foo/bar/baz.ts]


//// [/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo.ts",
    "/foo.tsx",
    "/foo.d.ts",
    "/foo.js",
    "/foo.jsx",
    "/foo/package.json",
    "/foo/index.ts",
    "/foo/index.tsx",
    "/foo/index.d.ts",
    "/foo/index.js",
    "/foo/index.jsx"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .tspp with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo.ts",
    "/foo.tsx",
    "/foo.d.ts",
    "/foo.js",
    "/foo.jsx",
    "/foo/package.json",
    "/foo/index.ts",
    "/foo/index.tsx",
    "/foo/index.d.ts",
    "/foo/index.js",
    "/foo/index.jsx"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .d.tspp
//// [/foo/bar/baz.ts]


//// [/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo.ts",
    "/foo.tsx",
    "/foo.d.ts",
    "/foo.js",
    "/foo.jsx",
    "/foo/package.json",
    "/foo/index.ts",
    "/foo/index.tsx",
    "/foo/index.d.ts",
    "/foo/index.js",
    "/foo/index.jsx"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .d.tspp with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "/foo.ts",
    "/foo.tsx",
    "/foo.d.ts",
    "/foo.js",
    "/foo.jsx",
    "/foo/package.json",
    "/foo/index.ts",
    "/foo/index.tsx",
    "/foo/index.d.ts",
    "/foo/index.js",
    "/foo/index.jsx"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .ts
//// [/foo/bar/baz.ts]


//// [/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .ts with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .tsx
//// [/foo/bar/baz.ts]


//// [/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo.ts"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .tsx with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo.ts"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .d.ts
//// [/foo/bar/baz.ts]


//// [/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo.ts",
    "/foo.tsx"
  ]
}

Resolving "/foo" from /foo/bar/baz.ts when module has extension: .d.ts with host that doesnt have directoryExists
//// [/foo/bar/baz.ts]


//// [/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "/foo.ts",
    "/foo.tsx"
  ]
}


load as file with name starting with window root
Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .tspp
//// [c:/foo/bar/baz.ts]


//// [c:/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "c:/foo.ts",
    "c:/foo.tsx",
    "c:/foo.d.ts",
    "c:/foo.js",
    "c:/foo.jsx",
    "c:/foo/package.json",
    "c:/foo/index.ts",
    "c:/foo/index.tsx",
    "c:/foo/index.d.ts",
    "c:/foo/index.js",
    "c:/foo/index.jsx"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .tspp with host that doesnt have directoryExists
//// [c:/foo/bar/baz.ts]


//// [c:/foo.tspp]


Resolution:: {
  "failedLookupLocations": [
    "c:/foo.ts",
    "c:/foo.tsx",
    "c:/foo.d.ts",
    "c:/foo.js",
    "c:/foo.jsx",
    "c:/foo/package.json",
    "c:/foo/index.ts",
    "c:/foo/index.tsx",
    "c:/foo/index.d.ts",
    "c:/foo/index.js",
    "c:/foo/index.jsx"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .d.tspp
//// [c:/foo/bar/baz.ts]


//// [c:/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "c:/foo.ts",
    "c:/foo.tsx",
    "c:/foo.d.ts",
    "c:/foo.js",
    "c:/foo.jsx",
    "c:/foo/package.json",
    "c:/foo/index.ts",
    "c:/foo/index.tsx",
    "c:/foo/index.d.ts",
    "c:/foo/index.js",
    "c:/foo/index.jsx"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .d.tspp with host that doesnt have directoryExists
//// [c:/foo/bar/baz.ts]


//// [c:/foo.d.tspp]


Resolution:: {
  "failedLookupLocations": [
    "c:/foo.ts",
    "c:/foo.tsx",
    "c:/foo.d.ts",
    "c:/foo.js",
    "c:/foo.jsx",
    "c:/foo/package.json",
    "c:/foo/index.ts",
    "c:/foo/index.tsx",
    "c:/foo/index.d.ts",
    "c:/foo/index.js",
    "c:/foo/index.jsx"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .ts
//// [c:/foo/bar/baz.ts]


//// [c:/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "c:/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .ts with host that doesnt have directoryExists
//// [c:/foo/bar/baz.ts]


//// [c:/foo.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "c:/foo.ts",
    "extension": ".ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  }
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .tsx
//// [c:/foo/bar/baz.ts]


//// [c:/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "c:/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "c:/foo.ts"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .tsx with host that doesnt have directoryExists
//// [c:/foo/bar/baz.ts]


//// [c:/foo.tsx]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "c:/foo.tsx",
    "extension": ".tsx",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "c:/foo.ts"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .d.ts
//// [c:/foo/bar/baz.ts]


//// [c:/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "c:/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "c:/foo.ts",
    "c:/foo.tsx"
  ]
}

Resolving "c:/foo" from c:/foo/bar/baz.ts when module has extension: .d.ts with host that doesnt have directoryExists
//// [c:/foo/bar/baz.ts]


//// [c:/foo.d.ts]


Resolution:: {
  "resolvedModule": {
    "resolvedFileName": "c:/foo.d.ts",
    "extension": ".d.ts",
    "isExternalLibraryImport": false,
    "resolvedUsingTsExtension": false
  },
  "failedLookupLocations": [
    "c:/foo.ts",
    "c:/foo.tsx"
  ]
}

