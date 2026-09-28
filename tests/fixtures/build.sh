#!/bin/sh
# Compiles the Swift test fixtures in this directory into loadable dylibs and
# writes their absolute paths to paths.ts (gitignored) for the injected agent to
# Module.load(). Always emits paths.ts so the test bundle resolves; when no Swift
# toolchain is present it writes empty paths and the loaders fail at Module.load.
set -e

fixtures="$(cd "$(dirname "$0")" && pwd)"
paths="$fixtures/paths.ts"
bytes="$fixtures/bytes.ts"

emit_paths() {
  printf 'export const FIXTURE_DYLIB = "%s";\nexport const RESILIENT_DYLIB = "%s";\nexport const FIXTURESYMS_DYLIB = "%s";\nexport const NOMETADATA_DYLIB = "%s";\nexport const CONFORMANCE_DYLIB = "%s";\nexport const OPTIMIZED_DYLIB = "%s";\n' "$1" "$2" "$3" "$4" "$5" "$6" >"$paths"
}

emit_empty_bytes() {
  printf 'export const FIXTURE_B64 = "";\nexport const RESILIENT_B64 = "";\nexport const FIXTURESYMS_B64 = "";\nexport const NOMETADATA_B64 = "";\nexport const CONFORMANCE_B64 = "";\nexport const OPTIMIZED_B64 = "";\n' >"$bytes"
}

# EMBED_FIXTURES base64s the dylibs into bytes.ts for remote targets that lack the
# host build paths; off by default so the local bundle stays small.
emit_bytes() {
  if [ -z "$EMBED_FIXTURES" ]; then
    emit_empty_bytes
    return
  fi
  {
    printf 'export const FIXTURE_B64 = "'; base64 <"$1" | tr -d '\n'
    printf '";\nexport const RESILIENT_B64 = "'; base64 <"$2" | tr -d '\n'
    printf '";\nexport const FIXTURESYMS_B64 = "'; base64 <"$3" | tr -d '\n'
    printf '";\nexport const NOMETADATA_B64 = "'; base64 <"$4" | tr -d '\n'
    printf '";\nexport const CONFORMANCE_B64 = "'; base64 <"$5" | tr -d '\n'
    printf '";\nexport const OPTIMIZED_B64 = "'; base64 <"$6" | tr -d '\n'
    printf '";\n'
  } >"$bytes"
}

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build fixtures: swiftc not found; skipping Swift fixture build"
  emit_paths "" "" "" "" "" ""
  emit_empty_bytes
  exit 0
fi

case "$(uname -s)" in
  Darwin) host=macos ;;
  Linux)  host=linux ;;
  *)      host="$(uname -s)" ;;
esac
platform="${PLATFORM:-$host}"

# fixture/resilient are stripped on every platform, matching a real release binary; resilient
# stays unstripped until fixture/fixturesyms have linked against it. fixturesyms is the same
# source, deliberately left unstripped. conformance stays unstripped so its witness thunks can
# name requirements that fixture's own stripped conformances cannot. optimized is the one fixture
# built with -O, stripped like a release binary.
case "$platform" in
  ios)
    dep="${IOS_DEPLOYMENT_TARGET:-17.0}"
    work="$fixtures/.ios"
    rm -rf "$work"

    fixture_out="$fixtures/fixture.dylib"
    resilient_out="$fixtures/resilient.dylib"
    fixturesyms_out="$fixtures/fixturesyms.dylib"
    nometadata_out="$fixtures/nometadata.dylib"
    conformance_out="$fixtures/conformance.dylib"
    optimized_out="$fixtures/optimized.dylib"

    for arch in arm64 arm64e; do
      mkdir -p "$work/$arch"
      xcrun -sdk iphoneos swiftc -target "${arch}-apple-ios${dep}" \
        -emit-library -emit-module -enable-library-evolution -module-name resilient \
        "$fixtures/resilient.swift" -o "$work/$arch/resilient.dylib" \
        -emit-module-path "$work/$arch/resilient.swiftmodule" \
        -Xlinker -install_name -Xlinker @rpath/resilient.dylib

      for mod in fixture fixturesyms; do
        xcrun -sdk iphoneos swiftc -target "${arch}-apple-ios${dep}" \
          -emit-library -emit-module -module-name "$mod" "$fixtures/fixture.swift" \
          -I "$work/$arch" "$work/$arch/resilient.dylib" -o "$work/$arch/$mod.dylib" \
          -emit-module-path "$work/$arch/$mod.swiftmodule" \
          -Xlinker -install_name -Xlinker "@rpath/$mod.dylib" \
          -Xlinker -rpath -Xlinker @loader_path
      done

      for mod in nometadata conformance; do
        xcrun -sdk iphoneos swiftc -target "${arch}-apple-ios${dep}" \
          -emit-library -module-name "$mod" "$fixtures/$mod.swift" \
          -I "$work/$arch" "$work/$arch/fixture.dylib" "$work/$arch/resilient.dylib" \
          -o "$work/$arch/$mod.dylib" \
          -Xlinker -install_name -Xlinker "@rpath/$mod.dylib" \
          -Xlinker -rpath -Xlinker @loader_path
      done

      xcrun -sdk iphoneos swiftc -target "${arch}-apple-ios${dep}" -O \
        -emit-library -module-name optimized "$fixtures/optimized.swift" -o "$work/$arch/optimized.dylib" \
        -Xlinker -install_name -Xlinker @rpath/optimized.dylib
    done

    lipo -create "$work/arm64/resilient.dylib"   "$work/arm64e/resilient.dylib"   -output "$resilient_out"
    lipo -create "$work/arm64/fixture.dylib"     "$work/arm64e/fixture.dylib"     -output "$fixture_out"
    lipo -create "$work/arm64/fixturesyms.dylib" "$work/arm64e/fixturesyms.dylib" -output "$fixturesyms_out"
    lipo -create "$work/arm64/nometadata.dylib"  "$work/arm64e/nometadata.dylib"  -output "$nometadata_out"
    lipo -create "$work/arm64/conformance.dylib" "$work/arm64e/conformance.dylib" -output "$conformance_out"
    lipo -create "$work/arm64/optimized.dylib"   "$work/arm64e/optimized.dylib"   -output "$optimized_out"
    rm -rf "$work"

    xcrun strip -x "$fixture_out" "$resilient_out" "$nometadata_out" "$optimized_out"
    codesign -s - -f "$fixture_out"
    codesign -s - -f "$fixturesyms_out"
    codesign -s - -f "$resilient_out"
    codesign -s - -f "$nometadata_out"
    codesign -s - -f "$conformance_out"
    codesign -s - -f "$optimized_out"

    emit_paths "$fixture_out" "$resilient_out" "$fixturesyms_out" "$nometadata_out" "$conformance_out" "$optimized_out"
    emit_bytes "$fixture_out" "$resilient_out" "$fixturesyms_out" "$nometadata_out" "$conformance_out" "$optimized_out"
    ;;
  macos)
    fixture_out="$fixtures/fixture.dylib"
    resilient_out="$fixtures/resilient.dylib"
    fixturesyms_out="$fixtures/fixturesyms.dylib"
    nometadata_out="$fixtures/nometadata.dylib"
    conformance_out="$fixtures/conformance.dylib"
    optimized_out="$fixtures/optimized.dylib"

    # ARCH=arm64e pins the arm64e slice so fixtures match an arm64e (PAC) host.
    if [ -n "$ARCH" ]; then
      target_flag="-target ${ARCH}-apple-macos$(sw_vers -productVersion | cut -d. -f1).0"
    else
      target_flag=""
    fi

    swiftc $target_flag -emit-library -emit-module -enable-library-evolution -module-name resilient \
      "$fixtures/resilient.swift" -o "$resilient_out" \
      -Xlinker -install_name -Xlinker "$resilient_out"

    swiftc $target_flag -emit-library -emit-module -module-name fixture "$fixtures/fixture.swift" -I "$fixtures" "$resilient_out" -o "$fixture_out"
    xcrun strip -x "$fixture_out"
    codesign -s - -f "$fixture_out"

    swiftc $target_flag -emit-library -module-name fixturesyms "$fixtures/fixture.swift" -I "$fixtures" "$resilient_out" -o "$fixturesyms_out"
    codesign -s - -f "$fixturesyms_out"

    for mod in nometadata conformance; do
      swiftc $target_flag -emit-library -module-name "$mod" "$fixtures/$mod.swift" \
        -I "$fixtures" "$fixture_out" "$resilient_out" -o "$fixtures/$mod.dylib" \
        -Xlinker -install_name -Xlinker "$fixtures/$mod.dylib"
      if [ "$mod" = nometadata ]; then
        xcrun strip -x "$fixtures/$mod.dylib"
      fi
      codesign -s - -f "$fixtures/$mod.dylib"
    done

    xcrun strip -x "$resilient_out"
    codesign -s - -f "$resilient_out"

    swiftc $target_flag -O -emit-library -module-name optimized "$fixtures/optimized.swift" -o "$optimized_out"
    xcrun strip -x "$optimized_out"
    codesign -s - -f "$optimized_out"

    emit_paths "$fixture_out" "$resilient_out" "$fixturesyms_out" "$nometadata_out" "$conformance_out" "$optimized_out"
    emit_bytes "$fixture_out" "$resilient_out" "$fixturesyms_out" "$nometadata_out" "$conformance_out" "$optimized_out"

    if [ "$ARCH" = "arm64e" ]; then
      host_out="$fixtures/host"
      clang -arch arm64e -o "$host_out" "$fixtures/host.c"
      codesign -s - -f --entitlements "$fixtures/host.entitlements" "$host_out"
    fi
    ;;
  linux)
    fixture_out="$fixtures/fixture.so"
    resilient_out="$fixtures/resilient.so"
    fixturesyms_out="$fixtures/fixturesyms.so"
    nometadata_out="$fixtures/nometadata.so"
    conformance_out="$fixtures/conformance.so"
    optimized_out="$fixtures/optimized.so"

    swiftc -emit-library -emit-module -enable-library-evolution -module-name resilient \
      "$fixtures/resilient.swift" -o "$resilient_out" \
      -Xlinker -soname -Xlinker "$resilient_out"

    swiftc -emit-library -emit-module -module-name fixture "$fixtures/fixture.swift" -I "$fixtures" "$resilient_out" -o "$fixture_out"
    swiftc -emit-library -module-name fixturesyms "$fixtures/fixture.swift" -I "$fixtures" "$resilient_out" -o "$fixturesyms_out"
    for mod in nometadata conformance; do
      swiftc -emit-library -module-name "$mod" "$fixtures/$mod.swift" -I "$fixtures" \
        "$fixture_out" "$resilient_out" -o "$fixtures/$mod.so" \
        -Xlinker -soname -Xlinker "$fixtures/$mod.so"
    done
    swiftc -O -emit-library -module-name optimized "$fixtures/optimized.swift" -o "$optimized_out"

    # Also proves section discovery is symbol-independent.
    strip "$fixture_out" "$resilient_out" "$nometadata_out" "$optimized_out"

    emit_paths "$fixture_out" "$resilient_out" "$fixturesyms_out" "$nometadata_out" "$conformance_out" "$optimized_out"
    emit_bytes "$fixture_out" "$resilient_out" "$fixturesyms_out" "$nometadata_out" "$conformance_out" "$optimized_out"
    ;;
  *)
    echo "build fixtures: unsupported platform $platform" >&2
    exit 1
    ;;
esac
