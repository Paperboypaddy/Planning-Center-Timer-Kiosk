{
  description = "Planning Center Timer Kiosk — NixOS package and module (nixpkgs-shaped)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      overlays.default = final: _prev: {
        planningcenter-timer-kiosk = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ self.overlays.default ];
          };
        in
        {
          default = pkgs.planningcenter-timer-kiosk;
          planningcenter-timer-kiosk = pkgs.planningcenter-timer-kiosk;
        }
      );

      nixosModules.default = self.nixosModules.planningcenter-timer-kiosk;
      nixosModules.planningcenter-timer-kiosk =
        { ... }:
        {
          imports = [ ./nix/module.nix ];
          nixpkgs.overlays = [ self.overlays.default ];
        };

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ self.overlays.default ];
          };
        in
        {
          package = self.packages.${system}.planningcenter-timer-kiosk;
          nixos = pkgs.callPackage ./nix/nixos-test.nix { inherit self; };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
