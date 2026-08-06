{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
}:

buildNpmPackage rec {
  pname = "planningcenter-timer-kiosk";
  version = "2026.8.5-beta.2";

  src = lib.cleanSourceWith {
    src = lib.cleanSource ../.;
    filter =
      path: _type:
      let
        base = baseNameOf path;
      in
      !(builtins.elem base [
        "test"
        "app"
        "installer"
        "node_modules"
        "nix"
        "flake.nix"
        "flake.lock"
        ".github"
        "AGENTS.md"
      ]);
  };

  npmDepsHash = "sha256-F82d19mvmXdBg3/VGcKf1W3Nsd+FUW2vrYE0VM9ewMQ=";

  nativeBuildInputs = [ makeWrapper ];

  # Build the Vite/React control panel into public/ before install.
  npmBuildScript = "build:panel";

  # Application layout (not a library under node_modules/).
  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/planningcenter-timer-kiosk $out/bin
    cp -r server public kiosk package.json node_modules $out/lib/planningcenter-timer-kiosk/

    makeWrapper ${lib.getExe nodejs} $out/bin/planningcenter-timer-kiosk \
      --add-flags "$out/lib/planningcenter-timer-kiosk/server/index.js"

    makeWrapper ${lib.getExe nodejs} $out/bin/planningcenter-timer-kiosk-browser \
      --add-flags "$out/lib/planningcenter-timer-kiosk/kiosk/launch-kiosk.js"

    makeWrapper ${lib.getExe nodejs} $out/bin/planningcenter-timer-kiosk-gen-cert \
      --add-flags "$out/lib/planningcenter-timer-kiosk/kiosk/gen-cert.js"

    runHook postInstall
  '';

  meta = {
    description = "Kiosk controller for Planning Center Services live/countdown pages";
    homepage = "https://github.com/Paperboypaddy/Planning-Center-Timer-Kiosk";
    license = lib.licenses.agpl3Only;
    maintainers = [ ];
    platforms = lib.platforms.linux;
    mainProgram = "planningcenter-timer-kiosk";
  };
}
