export function validateMasonryLaunch(doc: unknown): {
  squareCap: number;
  allocatedSquare: number;
  vestedSquare: number;
  /** Liquid xSHARE the deployer/DAO address starts with: `deployer` + `initial.deployerDao`. */
  liquidDeployerSquare: number;
  initialLevelFunding: number;
  levelLaunchSupply: number;
};
