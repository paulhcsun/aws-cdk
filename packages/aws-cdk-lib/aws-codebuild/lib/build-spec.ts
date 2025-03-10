import { Construct } from 'constructs';
import * as yaml_cfn from './private/yaml-cfn';
import { Project } from './project';
import * as s3_assets from '../../aws-s3-assets';
import { IResolveContext, Lazy, Stack, UnscopedValidationError } from '../../core';

/**
 * BuildSpec for CodeBuild projects
 */
export abstract class BuildSpec {
  public static fromObject(value: { [key: string]: any }): BuildSpec {
    return new ObjectBuildSpec(value);
  }

  /**
   * Create a buildspec from an object that will be rendered as YAML in the resulting CloudFormation template.
   *
   * @param value the object containing the buildspec that will be rendered as YAML
   */
  public static fromObjectToYaml(value: { [key: string]: any }): BuildSpec {
    return new YamlBuildSpec(value);
  }

  /**
   * Use a file from the source as buildspec
   *
   * Use this if you want to use a file different from 'buildspec.yml'`
   */
  public static fromSourceFilename(filename: string): BuildSpec {
    return new FilenameBuildSpec(filename);
  }

  /**
   * Use the contents of a local file as the build spec string
   *
   * Use this if you have a local .yml or .json file that you want to use as the buildspec
   */
  public static fromAsset(path: string): BuildSpec {
    return new AssetBuildSpec(path);
  }

  /**
   * Whether the buildspec is directly available or deferred until build-time
   */
  public abstract readonly isImmediate: boolean;

  protected constructor() {
  }

  /**
   * Render the represented BuildSpec
   */
  public abstract toBuildSpec(scope?: Construct): string;
}

/**
 * BuildSpec that just returns the contents of a local file
 */
class AssetBuildSpec extends BuildSpec {
  public readonly isImmediate: boolean = true;
  public asset?: s3_assets.Asset;

  constructor(public readonly path: string, private readonly options: s3_assets.AssetOptions = { }) {
    super();
  }

  public toBuildSpec(scope?: Project): string {
    if (!scope) {
      throw new UnscopedValidationError('`AssetBuildSpec` requires a `scope` argument');
    }

    // If the same AssetCode is used multiple times, retain only the first instantiation.
    if (!this.asset) {
      this.asset = new s3_assets.Asset(scope, 'Code', {
        path: this.path,
        ...this.options,
      });
    } else if (Stack.of(this.asset) !== Stack.of(scope)) {
      throw new UnscopedValidationError(`Asset is already associated with another stack '${Stack.of(this.asset).stackName}'. ` +
        'Create a new BuildSpec instance for every stack.');
    }

    this.asset.grantRead(scope);
    return this.asset.bucket.arnForObjects(this.asset.s3ObjectKey);
  }

  public toString() {
    return `<buildspec file: ${this.path}>`;
  }
}

/**
 * BuildSpec that just returns the input unchanged
 */
class FilenameBuildSpec extends BuildSpec {
  public readonly isImmediate: boolean = false;

  constructor(private readonly filename: string) {
    super();
  }

  public toBuildSpec(): string {
    return this.filename;
  }

  public toString() {
    return `<buildspec file: ${this.filename}>`;
  }
}

/**
 * BuildSpec that understands about structure
 */
class ObjectBuildSpec extends BuildSpec {
  public readonly isImmediate: boolean = true;

  constructor(public readonly spec: { [key: string]: any }) {
    super();
  }

  public toBuildSpec(): string {
    // We have to pretty-print the buildspec, otherwise
    // CodeBuild will not recognize it as an inline buildspec.
    return Lazy.uncachedString({
      produce: (ctx: IResolveContext) =>
        Stack.of(ctx.scope).toJsonString(this.spec, 2),
    });
  }
}

/**
 * BuildSpec that exports into YAML format
 */
class YamlBuildSpec extends BuildSpec {
  public readonly isImmediate: boolean = true;

  constructor(public readonly spec: { [key: string]: any }) {
    super();
  }

  public toBuildSpec(): string {
    return yaml_cfn.serialize(this.spec);
  }
}

/**
 * Merge two buildspecs into a new BuildSpec by doing a deep merge
 *
 * We decided to disallow merging of artifact specs, which is
 * actually impossible since we can't merge two buildspecs with a
 * single primary output into a buildspec with multiple outputs.
 * In case of multiple outputs they must have identifiers but we won't have that information.
 *
 * In case of test reports we replace the whole object with the RHS (instead of recursively merging)
 */
export function mergeBuildSpecs(lhs: BuildSpec, rhs: BuildSpec): BuildSpec {
  if (!(lhs instanceof ObjectBuildSpec) || !(rhs instanceof ObjectBuildSpec)) {
    throw new UnscopedValidationError('Can only merge buildspecs created using BuildSpec.fromObject()');
  }

  if (lhs.spec.version === '0.1') {
    throw new UnscopedValidationError('Cannot extend buildspec at version "0.1". Set the version to "0.2" or higher instead.');
  }
  if (lhs.spec.artifacts && rhs.spec.artifacts) {
    // We decided to disallow merging of artifact specs, which is
    // actually impossible since we can't merge two buildspecs with a
    // single primary output into a buildspec with multiple outputs.
    // In case of multiple outputs they must have identifiers but we won't have that information.
    throw new UnscopedValidationError('Only one build spec is allowed to specify artifacts.');
  }

  const lhsSpec = JSON.parse(JSON.stringify(lhs.spec));
  const rhsSpec = JSON.parse(JSON.stringify(rhs.spec));

  normalizeSpec(lhsSpec);
  normalizeSpec(rhsSpec);

  const merged = mergeDeep(lhsSpec, rhsSpec);

  // In case of test reports we replace the whole object with the RHS (instead of recursively merging)
  if (lhsSpec.reports && rhsSpec.reports) {
    merged.reports = { ...lhsSpec.reports, ...rhsSpec.reports };
  }

  return new ObjectBuildSpec(merged);
}

/*
 * Normalizes the build spec
 * The CodeBuild runtime allows fields that are defined as string[] to be strings
 * and interprets them as singleton lists.
 * When merging we need to normalize this to have the correct concat semantics
 */
function normalizeSpec(spec: { [key: string]: any }): void {
  if (spec.env && typeof spec.env['exported-variables'] === 'string') {
    spec.env['exported-variables'] = [spec.env['exported-variables']];
  }
  for (const key in spec.phases) {
    if (Object.prototype.hasOwnProperty.call(spec.phases, key)) {
      normalizeSpecPhase(spec.phases[key]);
    }
  }
  if (spec.reports) {
    for (const key in spec.reports) {
      if (Object.prototype.hasOwnProperty.call(spec.reports, key)) {
        const report = spec.reports[key];
        if (typeof report.files === 'string') {
          report.files = [report.files];
        }
      }
    }
  }
  if (spec.artifacts) {
    if (typeof spec.artifacts.files === 'string') {
      spec.artifacts.files = [spec.artifacts.files];
    }
    for (const key in spec.artifacts['secondary-artifacts']) {
      if (Object.prototype.hasOwnProperty.call(spec.artifacts['secondary-artifacts'], key)) {
        const secArtifact = spec.artifacts['secondary-artifacts'][key];
        if (typeof secArtifact.files === 'string') {
          secArtifact.files = [secArtifact.files];
        }
      }
    }
  }
  if (spec.cache && typeof spec.cache.paths === 'string') {
    spec.cache.paths = [spec.cache.paths];
  }
}

function normalizeSpecPhase(phase: { [key: string]: any }): void {
  if (phase.commands && typeof phase.commands === 'string') {
    phase.commands = [phase.commands];
  }
  if (phase.finally && typeof phase.finally === 'string') {
    phase.finally = [phase.finally];
  }
}

function mergeDeep(lhs: any, rhs: any): any {
  if (Array.isArray(lhs) && Array.isArray(rhs)) {
    return [...lhs, ...rhs];
  }
  if (Array.isArray(lhs) || Array.isArray(rhs)) {
    return rhs;
  }

  const isObject = (obj: any) => obj && typeof obj === 'object';

  if (isObject(lhs) && isObject(rhs)) {
    const ret: any = { ...lhs };
    for (const k of Object.keys(rhs)) {
      ret[k] = k in lhs ? mergeDeep(lhs[k], rhs[k]) : rhs[k];
    }
    return ret;
  }

  return rhs;
}
