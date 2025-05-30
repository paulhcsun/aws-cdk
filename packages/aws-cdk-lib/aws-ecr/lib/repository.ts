import { EOL } from 'os';
import { IConstruct, Construct } from 'constructs';
import { CfnRepository } from './ecr.generated';
import { LifecycleRule, TagStatus } from './lifecycle';
import * as events from '../../aws-events';
import * as iam from '../../aws-iam';
import * as kms from '../../aws-kms';
import * as cxschema from '../../cloud-assembly-schema';
import {
  Annotations,
  ArnFormat,
  IResource,
  Lazy,
  RemovalPolicy,
  Resource,
  Stack,
  Tags,
  Token,
  TokenComparison,
  CustomResource,
  Aws,
  ContextProvider,
  Arn,
  ValidationError,
  UnscopedValidationError,
} from '../../core';
import { addConstructMetadata, MethodMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';
import { AutoDeleteImagesProvider } from '../../custom-resource-handlers/dist/aws-ecr/auto-delete-images-provider.generated';

const AUTO_DELETE_IMAGES_RESOURCE_TYPE = 'Custom::ECRAutoDeleteImages';
const AUTO_DELETE_IMAGES_TAG = 'aws-cdk:auto-delete-images';

/**
 * Represents an ECR repository.
 */
export interface IRepository extends IResource {
  /**
   * The name of the repository
   * @attribute
   */
  readonly repositoryName: string;

  /**
   * The ARN of the repository
   * @attribute
   */
  readonly repositoryArn: string;

  /**
   * The URI of this repository (represents the latest image):
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY
   *
   * @attribute
   */
  readonly repositoryUri: string;

  /**
   * The URI of this repository's registry:
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com
   *
   * @attribute
   */
  readonly registryUri: string;

  /**
   * Returns the URI of the repository for a certain tag. Can be used in `docker push/pull`.
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[:TAG]
   *
   * @param tag Image tag to use (tools usually default to "latest" if omitted)
   */
  repositoryUriForTag(tag?: string): string;

  /**
   * Returns the URI of the repository for a certain digest. Can be used in `docker push/pull`.
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[@DIGEST]
   *
   * @param digest Image digest to use (tools usually default to the image with the "latest" tag if omitted)
   */
  repositoryUriForDigest(digest?: string): string;

  /**
   * Returns the URI of the repository for a certain tag or digest, inferring based on the syntax of the tag. Can be used in `docker push/pull`.
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[:TAG]
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[@DIGEST]
   *
   * @param tagOrDigest Image tag or digest to use (tools usually default to the image with the "latest" tag if omitted)
   */
  repositoryUriForTagOrDigest(tagOrDigest?: string): string;

  /**
   * Add a policy statement to the repository's resource policy
   */
  addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult;

  /**
   * Grant the given principal identity permissions to perform the actions on this repository
   */
  grant(grantee: iam.IGrantable, ...actions: string[]): iam.Grant;

  /**
   * Grant the given identity permissions to read images in this repository.
   */
  grantRead(grantee: iam.IGrantable): iam.Grant;

  /**
   * Grant the given identity permissions to pull images in this repository.
   */
  grantPull(grantee: iam.IGrantable): iam.Grant;

  /**
   * Grant the given identity permissions to push images in this repository.
   */
  grantPush(grantee: iam.IGrantable): iam.Grant;

  /**
   * Grant the given identity permissions to pull and push images to this repository.
   */
  grantPullPush(grantee: iam.IGrantable): iam.Grant;

  /**
   * Define a CloudWatch event that triggers when something happens to this repository
   *
   * Requires that there exists at least one CloudTrail Trail in your account
   * that captures the event. This method will not create the Trail.
   *
   * @param id The id of the rule
   * @param options Options for adding the rule
   */
  onCloudTrailEvent(id: string, options?: events.OnEventOptions): events.Rule;

  /**
   * Defines an AWS CloudWatch event rule that can trigger a target when an image is pushed to this
   * repository.
   *
   * Requires that there exists at least one CloudTrail Trail in your account
   * that captures the event. This method will not create the Trail.
   *
   * @param id The id of the rule
   * @param options Options for adding the rule
   */
  onCloudTrailImagePushed(id: string, options?: OnCloudTrailImagePushedOptions): events.Rule;

  /**
   * Defines an AWS CloudWatch event rule that can trigger a target when the image scan is completed
   *
   *
   * @param id The id of the rule
   * @param options Options for adding the rule
   */
  onImageScanCompleted(id: string, options?: OnImageScanCompletedOptions): events.Rule;

  /**
   * Defines a CloudWatch event rule which triggers for repository events. Use
   * `rule.addEventPattern(pattern)` to specify a filter.
   */
  onEvent(id: string, options?: events.OnEventOptions): events.Rule;
}

/**
 * Base class for ECR repository. Reused between imported repositories and owned repositories.
 */
export abstract class RepositoryBase extends Resource implements IRepository {
  private readonly REPO_PULL_ACTIONS: string[] = [
    'ecr:BatchCheckLayerAvailability',
    'ecr:GetDownloadUrlForLayer',
    'ecr:BatchGetImage',
  ];

  // https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-push.html#image-push-iam
  private readonly REPO_PUSH_ACTIONS: string[] = [
    'ecr:CompleteLayerUpload',
    'ecr:UploadLayerPart',
    'ecr:InitiateLayerUpload',
    'ecr:BatchCheckLayerAvailability',
    'ecr:PutImage',
  ];

  /**
   * The name of the repository
   */
  public abstract readonly repositoryName: string;

  /**
   * The ARN of the repository
   */
  public abstract readonly repositoryArn: string;

  /**
   * Add a policy statement to the repository's resource policy
   */
  public abstract addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult;

  /**
   * The URI of this repository (represents the latest image):
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY
   *
   */
  public get repositoryUri() {
    return this.repositoryUriForTag();
  }

  /**
   * The URI of this repository's registry:
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com
   *
   */
  public get registryUri(): string {
    const parts = this.stack.splitArn(this.repositoryArn, ArnFormat.SLASH_RESOURCE_NAME);
    return `${parts.account}.dkr.ecr.${parts.region}.${this.stack.urlSuffix}`;
  }

  /**
   * Returns the URL of the repository. Can be used in `docker push/pull`.
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[:TAG]
   *
   * @param tag Optional image tag
   */
  public repositoryUriForTag(tag?: string): string {
    const tagSuffix = tag ? `:${tag}` : '';
    return this.repositoryUriWithSuffix(tagSuffix);
  }

  /**
   * Returns the URL of the repository. Can be used in `docker push/pull`.
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[@DIGEST]
   *
   * @param digest Optional image digest
   */
  public repositoryUriForDigest(digest?: string): string {
    const digestSuffix = digest ? `@${digest}` : '';
    return this.repositoryUriWithSuffix(digestSuffix);
  }

  /**
   * Returns the URL of the repository. Can be used in `docker push/pull`.
   *
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[:TAG]
   *    ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY[@DIGEST]
   *
   * @param tagOrDigest Optional image tag or digest (digests must start with `sha256:`)
   */
  public repositoryUriForTagOrDigest(tagOrDigest?: string): string {
    if (tagOrDigest?.startsWith('sha256:')) {
      return this.repositoryUriForDigest(tagOrDigest);
    } else {
      return this.repositoryUriForTag(tagOrDigest);
    }
  }

  /**
   * Returns the repository URI, with an appended suffix, if provided.
   * @param suffix An image tag or an image digest.
   * @private
   */
  private repositoryUriWithSuffix(suffix?: string): string {
    const parts = this.stack.splitArn(this.repositoryArn, ArnFormat.SLASH_RESOURCE_NAME);
    return `${parts.account}.dkr.ecr.${parts.region}.${this.stack.urlSuffix}/${this.repositoryName}${suffix}`;
  }

  /**
   * Define a CloudWatch event that triggers when something happens to this repository
   *
   * Requires that there exists at least one CloudTrail Trail in your account
   * that captures the event. This method will not create the Trail.
   *
   * @param id The id of the rule
   * @param options Options for adding the rule
   */
  public onCloudTrailEvent(id: string, options: events.OnEventOptions = {}): events.Rule {
    const rule = new events.Rule(this, id, options);
    rule.addTarget(options.target);
    rule.addEventPattern({
      source: ['aws.ecr'],
      detailType: ['AWS API Call via CloudTrail'],
      detail: {
        requestParameters: {
          repositoryName: [this.repositoryName],
        },
      },
    });
    return rule;
  }

  /**
   * Defines an AWS CloudWatch event rule that can trigger a target when an image is pushed to this
   * repository.
   *
   * Requires that there exists at least one CloudTrail Trail in your account
   * that captures the event. This method will not create the Trail.
   *
   * @param id The id of the rule
   * @param options Options for adding the rule
   */
  public onCloudTrailImagePushed(id: string, options: OnCloudTrailImagePushedOptions = {}): events.Rule {
    const rule = this.onCloudTrailEvent(id, options);
    rule.addEventPattern({
      detail: {
        eventName: ['PutImage'],
        requestParameters: {
          imageTag: options.imageTag ? [options.imageTag] : undefined,
        },
      },
    });
    return rule;
  }
  /**
   * Defines an AWS CloudWatch event rule that can trigger a target when an image scan is completed
   *
   *
   * @param id The id of the rule
   * @param options Options for adding the rule
   */
  public onImageScanCompleted(id: string, options: OnImageScanCompletedOptions = {}): events.Rule {
    const rule = new events.Rule(this, id, options);
    rule.addTarget(options.target);
    rule.addEventPattern({
      source: ['aws.ecr'],
      detailType: ['ECR Image Scan'],
      detail: {
        'repository-name': [this.repositoryName],
        'scan-status': ['COMPLETE'],
        'image-tags': options.imageTags ?? undefined,
      },
    });
    return rule;
  }

  /**
   * Defines a CloudWatch event rule which triggers for repository events. Use
   * `rule.addEventPattern(pattern)` to specify a filter.
   */
  public onEvent(id: string, options: events.OnEventOptions = {}) {
    const rule = new events.Rule(this, id, options);
    rule.addEventPattern({
      source: ['aws.ecr'],
      detail: {
        'repository-name': [this.repositoryName],
      },
    });
    rule.addTarget(options.target);
    return rule;
  }

  /**
   * Grant the given principal identity permissions to perform the actions on this repository
   */
  public grant(grantee: iam.IGrantable, ...actions: string[]) {
    const crossAccountPrincipal = this.unsafeCrossAccountResourcePolicyPrincipal(grantee);
    if (crossAccountPrincipal) {
      // If the principal is from a different account,
      // that means addToPrincipalOrResource() will update the Resource Policy of this repo to trust that principal.
      // However, ECR verifies that the principal used in the Policy exists,
      // and will error out if it doesn't.
      // Because of that, if the principal is a newly created resource,
      // and there is not a dependency relationship between the Stacks of this repo and the principal,
      // trust the entire account of the principal instead
      // (otherwise, deploying this repo will fail).
      // To scope down the permissions as much as possible,
      // only trust principals from that account with a specific tag
      const crossAccountPrincipalStack = Stack.of(crossAccountPrincipal);
      const roleTag = `${crossAccountPrincipalStack.stackName}_${crossAccountPrincipal.node.addr}`;
      Tags.of(crossAccountPrincipal).add('aws-cdk:id', roleTag);
      this.addToResourcePolicy(new iam.PolicyStatement({
        actions,
        principals: [new iam.AccountPrincipal(crossAccountPrincipalStack.account)],
        conditions: {
          StringEquals: { 'aws:PrincipalTag/aws-cdk:id': roleTag },
        },
      }));

      return iam.Grant.addToPrincipal({
        grantee,
        actions,
        resourceArns: [this.repositoryArn],
        scope: this,
      });
    } else {
      return iam.Grant.addToPrincipalOrResource({
        grantee,
        actions,
        resourceArns: [this.repositoryArn],
        resourceSelfArns: [],
        resource: this,
      });
    }
  }

  /**
   * Grant the given identity permissions to read the images in this repository
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    return this.grant(grantee,
      'ecr:DescribeRepositories',
      'ecr:DescribeImages',
    );
  }

  /**
   * Grant the given identity permissions to use the images in this repository
   */
  public grantPull(grantee: iam.IGrantable) {
    const ret = this.grant(grantee, ...this.REPO_PULL_ACTIONS);

    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecr:GetAuthorizationToken'],
      resourceArns: ['*'],
      scope: this,
    });

    return ret;
  }

  /**
   * Grant the given identity permissions to use the images in this repository
   */
  public grantPush(grantee: iam.IGrantable) {
    const ret = this.grant(grantee, ...this.REPO_PUSH_ACTIONS);
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecr:GetAuthorizationToken'],
      resourceArns: ['*'],
      scope: this,
    });

    return ret;
  }

  /**
   * Grant the given identity permissions to pull and push images to this repository.
   */
  public grantPullPush(grantee: iam.IGrantable) {
    const ret = this.grant(grantee,
      ...this.REPO_PULL_ACTIONS,
      ...this.REPO_PUSH_ACTIONS,
    );
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecr:GetAuthorizationToken'],
      resourceArns: ['*'],
      scope: this,
    });

    return ret;
  }

  /**
   * Returns the resource that backs the given IAM grantee if we cannot put a direct reference
   * to the grantee in the resource policy of this ECR repository,
   * and 'undefined' in case we can.
   */
  private unsafeCrossAccountResourcePolicyPrincipal(grantee: iam.IGrantable): IConstruct | undefined {
    // A principal cannot be safely added to the Resource Policy of this ECR repository, if:
    // 1. The principal is from a different account, and
    // 2. The principal is a new resource (meaning, not just referenced), and
    // 3. The Stack this repo belongs to doesn't depend on the Stack the principal belongs to.

    // condition #1
    const principal = grantee.grantPrincipal;
    const principalAccount = principal.principalAccount;
    if (!principalAccount) {
      return undefined;
    }
    const repoAndPrincipalAccountCompare = Token.compareStrings(this.env.account, principalAccount);
    if (repoAndPrincipalAccountCompare === TokenComparison.BOTH_UNRESOLVED ||
        repoAndPrincipalAccountCompare === TokenComparison.SAME) {
      return undefined;
    }

    // condition #2
    if (!iam.principalIsOwnedResource(principal)) {
      return undefined;
    }

    // condition #3
    const principalStack = Stack.of(principal);
    if (this.stack.dependencies.includes(principalStack)) {
      return undefined;
    }

    return principal;
  }
}

/**
 * Options for the onCloudTrailImagePushed method
 */
export interface OnCloudTrailImagePushedOptions extends events.OnEventOptions {
  /**
   * Only watch changes to this image tag
   *
   * @default - Watch changes to all tags
   */
  readonly imageTag?: string;
}

/**
 * Options for the OnImageScanCompleted method
 */
export interface OnImageScanCompletedOptions extends events.OnEventOptions {
  /**
   * Only watch changes to the image tags specified.
   * Leave it undefined to watch the full repository.
   *
   * @default - Watch the changes to the repository with all image tags
   */
  readonly imageTags?: string[];
}

export interface RepositoryProps {
  /**
   * Name for this repository.
   *
   * The repository name must start with a letter and can only contain lowercase letters, numbers, hyphens, underscores, and forward slashes.
   *
   * > If you specify a name, you cannot perform updates that require replacement of this resource. You can perform updates that require no or some interruption. If you must replace the resource, specify a new name.
   *
   * @default Automatically generated name.
   */
  readonly repositoryName?: string;

  /**
   * The kind of server-side encryption to apply to this repository.
   *
   * If you choose KMS, you can specify a KMS key via `encryptionKey`. If
   * encryptionKey is not specified, an AWS managed KMS key is used.
   *
   * @default - `KMS` if `encryptionKey` is specified, or `AES256` otherwise.
   */
  readonly encryption?: RepositoryEncryption;

  /**
   * External KMS key to use for repository encryption.
   *
   * The 'encryption' property must be either not specified or set to "KMS".
   * An error will be emitted if encryption is set to "AES256".
   *
   * @default - If encryption is set to `KMS` and this property is undefined,
   * an AWS managed KMS key is used.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Life cycle rules to apply to this registry
   *
   * @default No life cycle rules
   */
  readonly lifecycleRules?: LifecycleRule[];

  /**
   * The AWS account ID associated with the registry that contains the repository.
   *
   * @see https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_PutLifecyclePolicy.html
   * @default The default registry is assumed.
   */
  readonly lifecycleRegistryId?: string;

  /**
   * Determine what happens to the repository when the resource/stack is deleted.
   *
   * @default RemovalPolicy.Retain
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Enable the scan on push when creating the repository
   *
   *  @default false
   */
  readonly imageScanOnPush?: boolean;

  /**
   * The tag mutability setting for the repository. If this parameter is omitted, the default setting of MUTABLE will be used which will allow image tags to be overwritten.
   *
   *  @default TagMutability.MUTABLE
   */
  readonly imageTagMutability?: TagMutability;

  /**
   * Whether all images should be automatically deleted when the repository is
   * removed from the stack or when the stack is deleted.
   *
   * Requires the `removalPolicy` to be set to `RemovalPolicy.DESTROY`.
   *
   * @default false
   * @deprecated Use `emptyOnDelete` instead.
   */
  readonly autoDeleteImages?: boolean;

  /**
   * If true, deleting the repository force deletes the contents of the repository. If false, the repository must be empty before attempting to delete it.
   *
   * @default false
   */
  readonly emptyOnDelete?: boolean;
}

/**
 * Properties for looking up an existing Repository.
 */
export interface RepositoryLookupOptions {
  /**
   * The name of the repository.
   *
   * @default - Do not filter on repository name
   */
  readonly repositoryName?: string;
  /**
   * The ARN of the repository.
   *
   * @default - Do not filter on repository ARN
   */
  readonly repositoryArn?: string;
}

export interface RepositoryAttributes {
  readonly repositoryName: string;
  readonly repositoryArn: string;
}

/**
 * Define an ECR repository
 */
@propertyInjectable
export class Repository extends RepositoryBase {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecr.Repository';

  /**
   * Lookup an existing repository
   */
  public static fromLookup(scope: Construct, id: string, options: RepositoryLookupOptions): IRepository {
    if (Token.isUnresolved(options.repositoryName) || Token.isUnresolved(options.repositoryArn)) {
      throw new UnscopedValidationError('Cannot look up a repository with a tokenized name or ARN.');
    }

    if (!options.repositoryArn && !options.repositoryName) {
      throw new UnscopedValidationError('At least one of `repositoryName` or `repositoryArn` must be provided.');
    }

    const identifier = options.repositoryName ??
      (options.repositoryArn ? Arn.split(options.repositoryArn, ArnFormat.SLASH_RESOURCE_NAME).resourceName : undefined);

    if (!identifier) {
      throw new UnscopedValidationError('Could not determine repository identifier from provided options.');
    }

    const response: {[key: string]: any}[] = ContextProvider.getValue(scope, {
      provider: cxschema.ContextProvider.CC_API_PROVIDER,
      props: {
        typeName: 'AWS::ECR::Repository',
        exactIdentifier: identifier,
        propertiesToReturn: ['Arn'],
      } as cxschema.CcApiContextQuery,
      dummyValue: [
        {
          Arn: Stack.of(scope).formatArn({
            service: 'ecr',
            region: 'us-east-1',
            account: '123456789012',
            resource: 'repository',
            resourceName: 'DUMMY_ARN',
          }),
        },
      ],
    }).value;

    const repository = response[0];
    const repositoryName = Arn.extractResourceName(repository.Arn, 'repository');

    return this.fromRepositoryAttributes(scope, id, {
      repositoryName: repositoryName,
      repositoryArn: repository.Arn,
    });
  }

  /**
   * Import a repository
   */
  public static fromRepositoryAttributes(scope: Construct, id: string, attrs: RepositoryAttributes): IRepository {
    class Import extends RepositoryBase {
      public readonly repositoryName = attrs.repositoryName;
      public readonly repositoryArn = attrs.repositoryArn;

      public addToResourcePolicy(_statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
        // dropped
        return { statementAdded: false };
      }
    }

    return new Import(scope, id);
  }

  public static fromRepositoryArn(scope: Construct, id: string, repositoryArn: string): IRepository {
    // if repositoryArn is a token, the repository name is also required. this is because
    // repository names can include "/" (e.g. foo/bar/myrepo) and it is impossible to
    // parse the name from an ARN using CloudFormation's split/select.
    if (Token.isUnresolved(repositoryArn)) {
      throw new UnscopedValidationError('"repositoryArn" is a late-bound value, and therefore "repositoryName" is required. Use `fromRepositoryAttributes` instead');
    }

    validateRepositoryArn();

    const repositoryName = repositoryArn.split('/').slice(1).join('/');

    class Import extends RepositoryBase {
      public repositoryName = repositoryName;
      public repositoryArn = repositoryArn;

      public addToResourcePolicy(_statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
        // dropped
        return { statementAdded: false };
      }
    }

    return new Import(scope, id, {
      environmentFromArn: repositoryArn,
    });

    function validateRepositoryArn() {
      const splitArn = repositoryArn.split(':');

      if (!splitArn[splitArn.length - 1].startsWith('repository/')) {
        throw new UnscopedValidationError(`Repository arn should be in the format 'arn:<PARTITION>:ecr:<REGION>:<ACCOUNT>:repository/<NAME>', got ${repositoryArn}.`);
      }
    }
  }

  public static fromRepositoryName(scope: Construct, id: string, repositoryName: string): IRepository {
    class Import extends RepositoryBase {
      public repositoryName = repositoryName;
      public repositoryArn = Repository.arnForLocalRepository(repositoryName, scope);

      public addToResourcePolicy(_statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
        // dropped
        return { statementAdded: false };
      }
    }

    return new Import(scope, id);
  }

  /**
   * Returns an ECR ARN for a repository that resides in the same account/region
   * as the current stack.
   */
  public static arnForLocalRepository(repositoryName: string, scope: IConstruct, account?: string): string {
    return Stack.of(scope).formatArn({
      account,
      service: 'ecr',
      resource: 'repository',
      resourceName: repositoryName,
    });
  }

  private static validateRepositoryName(physicalName: string) {
    const repositoryName = physicalName;
    if (!repositoryName || Token.isUnresolved(repositoryName)) {
      // the name is a late-bound value, not a defined string,
      // so skip validation
      return;
    }

    const errors: string[] = [];

    // Rules codified from https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecr-repository.html
    if (repositoryName.length < 2 || repositoryName.length > 256) {
      errors.push('Repository name must be at least 2 and no more than 256 characters');
    }
    const isPatternMatch = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(repositoryName);
    if (!isPatternMatch) {
      errors.push('Repository name must start with a letter and can only contain lowercase letters, numbers, hyphens, underscores, periods and forward slashes');
    }

    if (errors.length > 0) {
      throw new UnscopedValidationError(`Invalid ECR repository name (value: ${repositoryName})${EOL}${errors.join(EOL)}`);
    }
  }

  public readonly repositoryName: string;
  public readonly repositoryArn: string;
  private readonly lifecycleRules = new Array<LifecycleRule>();
  private readonly registryId?: string;
  private policyDocument?: iam.PolicyDocument;
  private readonly _resource: CfnRepository;

  constructor(scope: Construct, id: string, props: RepositoryProps = {}) {
    super(scope, id, {
      physicalName: props.repositoryName,
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    Repository.validateRepositoryName(this.physicalName);

    const resource = new CfnRepository(this, 'Resource', {
      repositoryName: this.physicalName,
      // It says "Text", but they actually mean "Object".
      repositoryPolicyText: Lazy.any({ produce: () => this.policyDocument }),
      lifecyclePolicy: Lazy.any({ produce: () => this.renderLifecyclePolicy() }),
      imageScanningConfiguration: props.imageScanOnPush !== undefined ? { scanOnPush: props.imageScanOnPush } : undefined,
      imageTagMutability: props.imageTagMutability || undefined,
      encryptionConfiguration: this.parseEncryption(props),
      emptyOnDelete: props.emptyOnDelete,
    });
    this._resource = resource;

    resource.applyRemovalPolicy(props.removalPolicy);

    this.registryId = props.lifecycleRegistryId;
    if (props.lifecycleRules) {
      props.lifecycleRules.forEach(this.addLifecycleRule.bind(this));
    }

    this.repositoryName = this.getResourceNameAttribute(resource.ref);
    this.repositoryArn = this.getResourceArnAttribute(resource.attrArn, {
      service: 'ecr',
      resource: 'repository',
      resourceName: this.physicalName,
    });

    if (props.emptyOnDelete && props.removalPolicy !== RemovalPolicy.DESTROY) {
      throw new ValidationError('Cannot use \'emptyOnDelete\' property on a repository without setting removal policy to \'DESTROY\'.', this);
    } else if (props.emptyOnDelete == undefined && props.autoDeleteImages) {
      if (props.removalPolicy !== RemovalPolicy.DESTROY) {
        throw new ValidationError('Cannot use \'autoDeleteImages\' property on a repository without setting removal policy to \'DESTROY\'.', this);
      }
      this.enableAutoDeleteImages();
    }

    this.node.addValidation({ validate: () => this.policyDocument?.validateForResourcePolicy() ?? [] });
  }

  /**
   * Add a policy statement to the repository's resource policy.
   *
   * While other resources policies in AWS either require or accept a resource section,
   * Cfn for ECR does not allow us to specify a resource policy.
   * It will fail if a resource section is present at all.
   */
  @MethodMetadata()
  public addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
    if (statement.resources.length) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecr:noResourceStatements', 'ECR resource policy does not allow resource statements.');
    }
    if (this.policyDocument === undefined) {
      this.policyDocument = new iam.PolicyDocument();
    }
    this.policyDocument.addStatements(statement);
    return { statementAdded: true, policyDependable: this.policyDocument };
  }

  /**
   * Add a life cycle rule to the repository
   *
   * Life cycle rules automatically expire images from the repository that match
   * certain conditions.
   */
  @MethodMetadata()
  public addLifecycleRule(rule: LifecycleRule) {
    // Validate rule here so users get errors at the expected location
    if (rule.tagStatus === undefined) {
      rule = { ...rule, tagStatus: rule.tagPrefixList === undefined && rule.tagPatternList === undefined ? TagStatus.ANY : TagStatus.TAGGED };
    }

    if (rule.tagStatus === TagStatus.TAGGED
      && (rule.tagPrefixList === undefined || rule.tagPrefixList.length === 0)
      && (rule.tagPatternList === undefined || rule.tagPatternList.length === 0)
    ) {
      throw new ValidationError('TagStatus.Tagged requires the specification of a tagPrefixList or a tagPatternList', this);
    }
    if (rule.tagStatus !== TagStatus.TAGGED && (rule.tagPrefixList !== undefined || rule.tagPatternList !== undefined)) {
      throw new ValidationError('tagPrefixList and tagPatternList can only be specified when tagStatus is set to Tagged', this);
    }
    if (rule.tagPrefixList !== undefined && rule.tagPatternList !== undefined) {
      throw new ValidationError('Both tagPrefixList and tagPatternList cannot be specified together in a rule', this);
    }
    if (rule.tagPatternList !== undefined) {
      rule.tagPatternList.forEach((pattern) => {
        const splitPatternLength = pattern.split('*').length;
        if (splitPatternLength > 5) {
          throw new ValidationError(`A tag pattern cannot contain more than four wildcard characters (*), pattern: ${pattern}, counts: ${splitPatternLength - 1}`, this);
        }
      });
    }
    if ((rule.maxImageAge !== undefined) === (rule.maxImageCount !== undefined)) {
      throw new ValidationError(`Life cycle rule must contain exactly one of 'maxImageAge' and 'maxImageCount', got: ${JSON.stringify(rule)}`, this);
    }

    if (rule.tagStatus === TagStatus.ANY && this.lifecycleRules.filter(r => r.tagStatus === TagStatus.ANY).length > 0) {
      throw new ValidationError('Life cycle can only have one TagStatus.Any rule', this);
    }

    this.lifecycleRules.push({ ...rule });
  }

  /**
   * Render the life cycle policy object
   */
  private renderLifecyclePolicy(): CfnRepository.LifecyclePolicyProperty | undefined {
    const stack = Stack.of(this);
    let lifecyclePolicyText: any;

    if (this.lifecycleRules.length === 0 && !this.registryId) { return undefined; }

    if (this.lifecycleRules.length > 0) {
      lifecyclePolicyText = JSON.stringify(stack.resolve({
        rules: this.orderedLifecycleRules().map(renderLifecycleRule),
      }));
    }

    return {
      lifecyclePolicyText,
      registryId: this.registryId,
    };
  }

  /**
   * Return life cycle rules with automatic ordering applied.
   *
   * Also applies validation of the 'any' rule.
   */
  private orderedLifecycleRules(): LifecycleRule[] {
    if (this.lifecycleRules.length === 0) { return []; }

    const prioritizedRules = this.lifecycleRules.filter(r => r.rulePriority !== undefined && r.tagStatus !== TagStatus.ANY);
    const autoPrioritizedRules = this.lifecycleRules.filter(r => r.rulePriority === undefined && r.tagStatus !== TagStatus.ANY);
    const anyRules = this.lifecycleRules.filter(r => r.tagStatus === TagStatus.ANY);
    if (anyRules.length > 0 && anyRules[0].rulePriority !== undefined && autoPrioritizedRules.length > 0) {
      // Supporting this is too complex for very little value. We just prohibit it.
      throw new ValidationError("Cannot combine prioritized TagStatus.Any rule with unprioritized rules. Remove rulePriority from the 'Any' rule.", this);
    }

    const prios = prioritizedRules.map(r => r.rulePriority!);
    let autoPrio = (prios.length > 0 ? Math.max(...prios) : 0) + 1;

    const ret = new Array<LifecycleRule>();
    for (const rule of prioritizedRules.concat(autoPrioritizedRules).concat(anyRules)) {
      ret.push({
        ...rule,
        rulePriority: rule.rulePriority ?? autoPrio++,
      });
    }

    // Do validation on the final array--might still be wrong because the user supplied all prios, but incorrectly.
    validateAnyRuleLast(ret);
    return ret;
  }

  /**
   * Set up key properties and return the Repository encryption property from the
   * user's configuration.
   */
  private parseEncryption(props: RepositoryProps): CfnRepository.EncryptionConfigurationProperty | undefined {
    // default based on whether encryptionKey is specified
    const encryptionType = props.encryption ?? (props.encryptionKey ? RepositoryEncryption.KMS : RepositoryEncryption.AES_256);

    // if encryption key is set, encryption must be set to KMS.
    if (encryptionType !== RepositoryEncryption.KMS && props.encryptionKey) {
      throw new ValidationError(`encryptionKey is specified, so 'encryption' must be set to KMS (value: ${encryptionType.value})`, this);
    }

    if (encryptionType === RepositoryEncryption.AES_256) {
      return undefined;
    }

    if (encryptionType === RepositoryEncryption.KMS) {
      return {
        encryptionType: 'KMS',
        kmsKey: props.encryptionKey?.keyArn,
      };
    }

    throw new ValidationError(`Unexpected 'encryptionType': ${encryptionType}`, this);
  }

  private enableAutoDeleteImages() {
    const firstTime = Stack.of(this).node.tryFindChild(`${AUTO_DELETE_IMAGES_RESOURCE_TYPE}CustomResourceProvider`) === undefined;
    const provider = AutoDeleteImagesProvider.getOrCreateProvider(this, AUTO_DELETE_IMAGES_RESOURCE_TYPE, {
      useCfnResponseWrapper: false,
      description: `Lambda function for auto-deleting images in ${this.repositoryName} repository.`,
    });

    if (firstTime) {
      // Use a iam policy to allow the custom resource to list & delete
      // images in the repository and the ability to get all repositories to find the arn needed on delete.
      provider.addToRolePolicy({
        Effect: 'Allow',
        Action: [
          'ecr:BatchDeleteImage',
          'ecr:DescribeRepositories',
          'ecr:ListImages',
          'ecr:ListTagsForResource',
        ],
        Resource: [`arn:${Aws.PARTITION}:ecr:${Stack.of(this).region}:${Stack.of(this).account}:repository/*`],
        Condition: {
          StringEquals: {
            ['ecr:ResourceTag/' + AUTO_DELETE_IMAGES_TAG]: 'true',
          },
        },
      });
    }

    const customResource = new CustomResource(this, 'AutoDeleteImagesCustomResource', {
      resourceType: AUTO_DELETE_IMAGES_RESOURCE_TYPE,
      serviceToken: provider.serviceToken,
      properties: {
        RepositoryName: this.repositoryName,
      },
    });
    customResource.node.addDependency(this);

    // We also tag the repository to record the fact that we want it autodeleted.
    // The custom resource will check this tag before actually doing the delete.
    // Because tagging and untagging will ALWAYS happen before the CR is deleted,
    // we can set `autoDeleteImages: false` without the removal of the CR emptying
    // the repository as a side effect.
    Tags.of(this._resource).add(AUTO_DELETE_IMAGES_TAG, 'true');
  }
}

function validateAnyRuleLast(rules: LifecycleRule[]) {
  const anyRules = rules.filter(r => r.tagStatus === TagStatus.ANY);
  if (anyRules.length === 1) {
    const maxPrio = Math.max(...rules.map(r => r.rulePriority!));
    if (anyRules[0].rulePriority !== maxPrio) {
      throw new UnscopedValidationError(`TagStatus.Any rule must have highest priority, has ${anyRules[0].rulePriority} which is smaller than ${maxPrio}`);
    }
  }
}

/**
 * Render the lifecycle rule to JSON
 */
function renderLifecycleRule(rule: LifecycleRule) {
  return {
    rulePriority: rule.rulePriority,
    description: rule.description,
    selection: {
      tagStatus: rule.tagStatus || TagStatus.ANY,
      tagPrefixList: rule.tagPrefixList,
      tagPatternList: rule.tagPatternList,
      countType: rule.maxImageAge !== undefined ? CountType.SINCE_IMAGE_PUSHED : CountType.IMAGE_COUNT_MORE_THAN,
      countNumber: rule.maxImageAge?.toDays() ?? rule.maxImageCount,
      countUnit: rule.maxImageAge !== undefined ? 'days' : undefined,
    },
    action: {
      type: 'expire',
    },
  };
}

/**
 * Select images based on counts
 */
enum CountType {
  /**
   * Set a limit on the number of images in your repository
   */
  IMAGE_COUNT_MORE_THAN = 'imageCountMoreThan',

  /**
   * Set an age limit on the images in your repository
   */
  SINCE_IMAGE_PUSHED = 'sinceImagePushed',
}

/**
 * The tag mutability setting for your repository.
 */
export enum TagMutability {
  /**
   * allow image tags to be overwritten.
   */
  MUTABLE = 'MUTABLE',

  /**
   * all image tags within the repository will be immutable which will prevent them from being overwritten.
   */
  IMMUTABLE = 'IMMUTABLE',

}

/**
 * Indicates whether server-side encryption is enabled for the object, and whether that encryption is
 * from the AWS Key Management Service (AWS KMS) or from Amazon S3 managed encryption (SSE-S3).
 * @see https://docs.aws.amazon.com/AmazonS3/latest/dev/UsingMetadata.html#SysMetadata
 */
export class RepositoryEncryption {
  /**
   * 'AES256'
   */
  public static readonly AES_256 = new RepositoryEncryption('AES256');
  /**
   * 'KMS'
   */
  public static readonly KMS = new RepositoryEncryption('KMS');
  /**
   * 'KMS_DSSE'
   */
  public static readonly KMS_DSSE = new RepositoryEncryption('KMS_DSSE');

  /**
   * @param value the string value of the encryption
   */
  protected constructor(public readonly value: string) { }
}
