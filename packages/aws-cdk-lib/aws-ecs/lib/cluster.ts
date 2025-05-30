import { Construct, IConstruct } from 'constructs';
import { BottleRocketImage, EcsOptimizedAmi } from './amis';
import { InstanceDrainHook } from './drain-hook/instance-drain-hook';
import { ECSMetrics } from './ecs-canned-metrics.generated';
import { CfnCluster, CfnCapacityProvider, CfnClusterCapacityProviderAssociations } from './ecs.generated';
import * as autoscaling from '../../aws-autoscaling';
import * as cloudwatch from '../../aws-cloudwatch';
import * as ec2 from '../../aws-ec2';
import * as iam from '../../aws-iam';
import { PolicyStatement, ServicePrincipal } from '../../aws-iam';
import * as kms from '../../aws-kms';
import { IKey } from '../../aws-kms';
import * as logs from '../../aws-logs';
import * as s3 from '../../aws-s3';
import * as cloudmap from '../../aws-servicediscovery';
import {
  Aws,
  Duration,
  IResource,
  Resource,
  Stack,
  Aspects,
  ArnFormat,
  IAspect,
  Token,
  Names,
  FeatureFlags, Annotations,
  ValidationError,
} from '../../core';
import { addConstructMetadata, MethodMetadata } from '../../core/lib/metadata-resource';
import { mutatingAspectPrio32333 } from '../../core/lib/private/aspect-prio';
import { propertyInjectable } from '../../core/lib/prop-injectable';
import { Disable_ECS_IMDS_Blocking, Enable_IMDS_Blocking_Deprecated_Feature } from '../../cx-api';

const CLUSTER_SYMBOL = Symbol.for('@aws-cdk/aws-ecs/lib/cluster.Cluster');

/**
 * The properties used to define an ECS cluster.
 */
export interface ClusterProps {
  /**
   * The name for the cluster.
   *
   * @default CloudFormation-generated name
   */
  readonly clusterName?: string;

  /**
   * The VPC where your ECS instances will be running or your ENIs will be deployed
   *
   * @default - creates a new VPC with two AZs
   */
  readonly vpc?: ec2.IVpc;

  /**
   * The service discovery namespace created in this cluster
   *
   * @default - no service discovery namespace created, you can use `addDefaultCloudMapNamespace` to add a
   * default service discovery namespace later.
   */
  readonly defaultCloudMapNamespace?: CloudMapNamespaceOptions;

  /**
   * The ec2 capacity to add to the cluster
   *
   * @default - no EC2 capacity will be added, you can use `addCapacity` to add capacity later.
   */
  readonly capacity?: AddCapacityOptions;

  /**
   * The capacity providers to add to the cluster
   *
   * @default - None. Currently only FARGATE and FARGATE_SPOT are supported.
   * @deprecated Use `ClusterProps.enableFargateCapacityProviders` instead.
   */
  readonly capacityProviders?: string[];

  /**
   * Whether to enable Fargate Capacity Providers
   *
   * @default false
   */
  readonly enableFargateCapacityProviders?: boolean;

  /**
   * If true CloudWatch Container Insights will be enabled for the cluster
   *
   * @default - Container Insights will be disabled for this cluster.
   * @deprecated See {@link containerInsightsV2}
   */
  readonly containerInsights?: boolean;

  /**
   * The CloudWatch Container Insights configuration for the cluster
   *  @default {@link ContainerInsights.DISABLED} This may be overridden by ECS account level settings.
   */
  readonly containerInsightsV2?: ContainerInsights;

  /**
   * The execute command configuration for the cluster
   *
   * @default - no configuration will be provided.
   */
  readonly executeCommandConfiguration?: ExecuteCommandConfiguration;

  /**
   * Encryption configuration for ECS Managed storage
   *
   * @default - no encryption will be applied.
   */
  readonly managedStorageConfiguration?: ManagedStorageConfiguration;
}

/**
 * The machine image type
 */
export enum MachineImageType {
  /**
   * Amazon ECS-optimized Amazon Linux 2 AMI
   */
  AMAZON_LINUX_2,
  /**
   * Bottlerocket AMI
   */
  BOTTLEROCKET,
}

/**
 * Determine the value for the canContainersAccessInstanceRole option if it is undefined.
 * The value is determined based on the @aws-cdk/aws-ecs:disableEcsImdsBlocking feature flag.
 */
const getCanContainersAccessInstanceRoleDefault = (canContainersAccessInstanceRole: boolean | undefined,
  disableEcsImdsBlockingFlag: boolean | undefined): boolean => {
  if (canContainersAccessInstanceRole !== undefined) {
    return canContainersAccessInstanceRole;
  }

  if (disableEcsImdsBlockingFlag === true) {
    return true;
  } else {
    return false;
  }
};

/**
 * A regional grouping of one or more container instances on which you can run tasks and services.
 */
@propertyInjectable
export class Cluster extends Resource implements ICluster {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecs.Cluster';

  /**
   * Return whether the given object is a Cluster
   */
  public static isCluster(x: any): x is Cluster {
    return x !== null && typeof (x) === 'object' && CLUSTER_SYMBOL in x;
  }

  /**
   * Import an existing cluster to the stack from its attributes.
   */
  public static fromClusterAttributes(scope: Construct, id: string, attrs: ClusterAttributes): ICluster {
    return new ImportedCluster(scope, id, attrs);
  }

  /**
   * Import an existing cluster to the stack from the cluster ARN.
   * This does not provide access to the vpc, hasEc2Capacity, or connections -
   * use the `fromClusterAttributes` method to access those properties.
   */
  public static fromClusterArn(scope: Construct, id: string, clusterArn: string): ICluster {
    const stack = Stack.of(scope);
    const arn = stack.splitArn(clusterArn, ArnFormat.SLASH_RESOURCE_NAME);
    const clusterName = arn.resourceName;

    if (!clusterName) {
      throw new ValidationError(`Missing required Cluster Name from Cluster ARN: ${clusterArn}`, scope);
    }

    const errorSuffix = 'is not available for a Cluster imported using fromClusterArn(), please use fromClusterAttributes() instead.';

    class Import extends Resource implements ICluster {
      public readonly clusterArn = clusterArn;
      public readonly clusterName = clusterName!;
      get hasEc2Capacity(): boolean {
        throw new ValidationError(`hasEc2Capacity ${errorSuffix}`, this);
      }
      get connections(): ec2.Connections {
        throw new ValidationError(`connections ${errorSuffix}`, this);
      }
      get vpc(): ec2.IVpc {
        throw new ValidationError(`vpc ${errorSuffix}`, this);
      }
    }

    return new Import(scope, id, {
      environmentFromArn: clusterArn,
    });
  }

  /**
   * Manage the allowed network connections for the cluster with Security Groups.
   */
  public readonly connections: ec2.Connections = new ec2.Connections();

  /**
   * The VPC associated with the cluster.
   */
  public readonly vpc: ec2.IVpc;

  /**
   * The Amazon Resource Name (ARN) that identifies the cluster.
   */
  public readonly clusterArn: string;

  /**
   * The name of the cluster.
   */
  public readonly clusterName: string;

  /**
   * The names of both ASG and Fargate capacity providers associated with the cluster.
   */
  private _capacityProviderNames: string[] = [];

  /**
   * The cluster default capacity provider strategy. This takes the form of a list of CapacityProviderStrategy objects.
   */
  private _defaultCapacityProviderStrategy: CapacityProviderStrategy[] = [];

  /**
   * The AWS Cloud Map namespace to associate with the cluster.
   */
  private _defaultCloudMapNamespace?: cloudmap.INamespace;

  /**
   * Specifies whether the cluster has EC2 instance capacity.
   */
  private _hasEc2Capacity: boolean = false;

  /**
   * The autoscaling group for added Ec2 capacity
   */
  private _autoscalingGroup?: autoscaling.IAutoScalingGroup;

  /**
   * The execute command configuration for the cluster
   */
  private _executeCommandConfiguration?: ExecuteCommandConfiguration;

  /**
   * The configuration for ECS managed Storage
   * @private
   */
  private _managedStorageConfiguration?: ManagedStorageConfiguration;

  /**
   * CfnCluster instance
   */
  private _cfnCluster: CfnCluster;

  /**
   * Constructs a new instance of the Cluster class.
   */
  constructor(scope: Construct, id: string, props: ClusterProps = {}) {
    super(scope, id, {
      physicalName: props.clusterName,
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if ((props.containerInsights !== undefined) && props.containerInsightsV2) {
      throw new ValidationError('You cannot set both containerInsights and containerInsightsV2', this);
    }

    /**
     * clusterSettings needs to be undefined if containerInsights is not explicitly set in order to allow any
     * containerInsights settings on the account to apply.  See:
     * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ecs-cluster-clustersettings.html#cfn-ecs-cluster-clustersettings-value
     */
    let clusterSettings: CfnCluster.ClusterSettingsProperty[] | undefined;
    if (props.containerInsights !== undefined) {
      clusterSettings = [{
        name: 'containerInsights',
        value: props.containerInsights ? ContainerInsights.ENABLED : ContainerInsights.DISABLED,
      }];
    } else if (props.containerInsightsV2 !== undefined) {
      clusterSettings = [{
        name: 'containerInsights',
        value: props.containerInsightsV2,
      }];
    }

    this._capacityProviderNames = props.capacityProviders ?? [];
    if (props.enableFargateCapacityProviders) {
      this.enableFargateCapacityProviders();
    }

    if (props.executeCommandConfiguration) {
      if ((props.executeCommandConfiguration.logging === ExecuteCommandLogging.OVERRIDE) !==
        (props.executeCommandConfiguration.logConfiguration !== undefined)) {
        throw new ValidationError('Execute command log configuration must only be specified when logging is OVERRIDE.', this);
      }
      this._executeCommandConfiguration = props.executeCommandConfiguration;
    }

    this._managedStorageConfiguration = props.managedStorageConfiguration;

    this._cfnCluster = new CfnCluster(this, 'Resource', {
      clusterName: this.physicalName,
      clusterSettings,
      configuration: this.renderClusterConfiguration(),
    });

    this.clusterArn = this.getResourceArnAttribute(this._cfnCluster.attrArn, {
      service: 'ecs',
      resource: 'cluster',
      resourceName: this.physicalName,
    });
    this.clusterName = this.getResourceNameAttribute(this._cfnCluster.ref);

    this.vpc = props.vpc || new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });

    this._defaultCloudMapNamespace = props.defaultCloudMapNamespace !== undefined
      ? this.addDefaultCloudMapNamespace(props.defaultCloudMapNamespace)
      : undefined;

    this._autoscalingGroup = props.capacity !== undefined
      ? this.addCapacity('DefaultAutoScalingGroup', props.capacity)
      : undefined;

    this.updateKeyPolicyForEphemeralStorageConfiguration(props.clusterName);

    // Only create cluster capacity provider associations if there are any EC2
    // capacity providers. Ordinarily we'd just add the construct to the tree
    // since it's harmless, but we'd prefer not to add unexpected new
    // resources to the stack which could surprise users working with
    // brown-field CDK apps and stacks.
    Aspects.of(this).add(new MaybeCreateCapacityProviderAssociations(this, id), {
      priority: mutatingAspectPrio32333(this),
    });
  }

  /**
   * Applies policy to the target key for encryption.
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-create-storage-key.html
   */
  private updateKeyPolicyForEphemeralStorageConfiguration(clusterName?: string) {
    const key = this._managedStorageConfiguration?.fargateEphemeralStorageKmsKey;
    if (!key) return;
    const clusterConditions = {
      StringEquals: {
        'kms:EncryptionContext:aws:ecs:clusterAccount': [Aws.ACCOUNT_ID],
        ...(clusterName && { 'kms:EncryptionContext:aws:ecs:clusterName': [clusterName] }),
      },
    };

    key.addToResourcePolicy(new PolicyStatement({
      sid: 'Allow generate data key access for Fargate tasks.',
      principals: [new ServicePrincipal('fargate.amazonaws.com')],
      resources: ['*'],
      actions: ['kms:GenerateDataKeyWithoutPlaintext'],
      conditions: clusterConditions,
    }));
    key.addToResourcePolicy(new PolicyStatement({
      sid: 'Allow grant creation permission for Fargate tasks.',
      principals: [new ServicePrincipal('fargate.amazonaws.com')],
      resources: ['*'],
      actions: ['kms:CreateGrant'],
      conditions: {
        ...clusterConditions,
        'ForAllValues:StringEquals': {
          'kms:GrantOperations': ['Decrypt'],
        },
      },
    }));
  }

  /**
   * Enable the Fargate capacity providers for this cluster.
   */
  @MethodMetadata()
  public enableFargateCapacityProviders() {
    for (const provider of ['FARGATE', 'FARGATE_SPOT']) {
      if (!this._capacityProviderNames.includes(provider)) {
        this._capacityProviderNames.push(provider);
      }
    }
  }

  /**
   * Add default capacity provider strategy for this cluster.
   *
   * @param defaultCapacityProviderStrategy cluster default capacity provider strategy. This takes the form of a list of CapacityProviderStrategy objects.
   *
   * For example
   * [
   *   {
   *     capacityProvider: 'FARGATE',
   *     base: 10,
   *     weight: 50
   *   }
   * ]
   */
  @MethodMetadata()
  public addDefaultCapacityProviderStrategy(defaultCapacityProviderStrategy: CapacityProviderStrategy[]) {
    if (this._defaultCapacityProviderStrategy.length > 0) {
      throw new ValidationError('Cluster default capacity provider strategy is already set.', this);
    }

    if (defaultCapacityProviderStrategy.some(dcp => dcp.capacityProvider.includes('FARGATE')) && defaultCapacityProviderStrategy.some(dcp => !dcp.capacityProvider.includes('FARGATE'))) {
      throw new ValidationError('A capacity provider strategy cannot contain a mix of capacity providers using Auto Scaling groups and Fargate providers. Specify one or the other and try again.', this);
    }

    defaultCapacityProviderStrategy.forEach(dcp => {
      if (!this._capacityProviderNames.includes(dcp.capacityProvider)) {
        throw new ValidationError(`Capacity provider ${dcp.capacityProvider} must be added to the cluster with addAsgCapacityProvider() before it can be used in a default capacity provider strategy.`, this);
      }
    });

    const defaultCapacityProvidersWithBase = defaultCapacityProviderStrategy.filter(dcp => !!dcp.base);
    if (defaultCapacityProvidersWithBase.length > 1) {
      throw new ValidationError('Only 1 capacity provider in a capacity provider strategy can have a nonzero base.', this);
    }
    this._defaultCapacityProviderStrategy = defaultCapacityProviderStrategy;
  }

  private renderClusterConfiguration(): CfnCluster.ClusterConfigurationProperty | undefined {
    if (!this._executeCommandConfiguration && !this._managedStorageConfiguration) return undefined;
    return {
      executeCommandConfiguration: this._executeCommandConfiguration && {
        kmsKeyId: this._executeCommandConfiguration.kmsKey?.keyArn,
        logConfiguration: this._executeCommandConfiguration.logConfiguration && this.renderExecuteCommandLogConfiguration(),
        logging: this._executeCommandConfiguration.logging,
      },
      managedStorageConfiguration: this._managedStorageConfiguration && {
        fargateEphemeralStorageKmsKeyId: this._managedStorageConfiguration.fargateEphemeralStorageKmsKey?.keyId,
        kmsKeyId: this._managedStorageConfiguration.kmsKey?.keyId,
      },
    };
  }

  private renderExecuteCommandLogConfiguration(): CfnCluster.ExecuteCommandLogConfigurationProperty {
    const logConfiguration = this._executeCommandConfiguration?.logConfiguration;
    if (logConfiguration?.s3EncryptionEnabled && !logConfiguration?.s3Bucket) {
      throw new ValidationError('You must specify an S3 bucket name in the execute command log configuration to enable S3 encryption.', this);
    }
    if (logConfiguration?.cloudWatchEncryptionEnabled && !logConfiguration?.cloudWatchLogGroup) {
      throw new ValidationError('You must specify a CloudWatch log group in the execute command log configuration to enable CloudWatch encryption.', this);
    }
    return {
      cloudWatchEncryptionEnabled: logConfiguration?.cloudWatchEncryptionEnabled,
      cloudWatchLogGroupName: logConfiguration?.cloudWatchLogGroup?.logGroupName,
      s3BucketName: logConfiguration?.s3Bucket?.bucketName,
      s3EncryptionEnabled: logConfiguration?.s3EncryptionEnabled,
      s3KeyPrefix: logConfiguration?.s3KeyPrefix,
    };
  }

  /**
   * Add an AWS Cloud Map DNS namespace for this cluster.
   * NOTE: HttpNamespaces are supported only for use cases involving Service Connect. For use cases involving both Service-
   * Discovery and Service Connect, customers should manage the HttpNamespace outside of the Cluster.addDefaultCloudMapNamespace method.
   */
  @MethodMetadata()
  public addDefaultCloudMapNamespace(options: CloudMapNamespaceOptions): cloudmap.INamespace {
    if (this._defaultCloudMapNamespace !== undefined) {
      throw new ValidationError('Can only add default namespace once.', this);
    }

    const namespaceType = options.type !== undefined
      ? options.type
      : cloudmap.NamespaceType.DNS_PRIVATE;

    let sdNamespace;
    switch (namespaceType) {
      case cloudmap.NamespaceType.DNS_PRIVATE:
        sdNamespace = new cloudmap.PrivateDnsNamespace(this, 'DefaultServiceDiscoveryNamespace', {
          name: options.name,
          vpc: this.vpc,
        });
        break;
      case cloudmap.NamespaceType.DNS_PUBLIC:
        sdNamespace = new cloudmap.PublicDnsNamespace(this, 'DefaultServiceDiscoveryNamespace', {
          name: options.name,
        });
        break;
      case cloudmap.NamespaceType.HTTP:
        sdNamespace = new cloudmap.HttpNamespace(this, 'DefaultServiceDiscoveryNamespace', {
          name: options.name,
        });
        break;
      default:
        throw new ValidationError(`Namespace type ${namespaceType} is not supported.`, this);
    }

    this._defaultCloudMapNamespace = sdNamespace;
    if (options.useForServiceConnect) {
      this._cfnCluster.serviceConnectDefaults = {
        namespace: sdNamespace.namespaceArn,
      };
    }

    return sdNamespace;
  }

  /**
   * Getter for _defaultCapacityProviderStrategy. This is necessary to correctly create Capacity Provider Associations.
   */
  public get defaultCapacityProviderStrategy() {
    return this._defaultCapacityProviderStrategy;
  }

  /**
   * Getter for _capacityProviderNames added to cluster
   */
  public get capacityProviderNames() {
    return this._capacityProviderNames;
  }

  /**
   * Getter for namespace added to cluster
   */
  public get defaultCloudMapNamespace(): cloudmap.INamespace | undefined {
    return this._defaultCloudMapNamespace;
  }

  /**
   * It is highly recommended to use `Cluster.addAsgCapacityProvider` instead of this method.
   *
   * This method adds compute capacity to a cluster by creating an AutoScalingGroup with the specified options.
   *
   * Returns the AutoScalingGroup so you can add autoscaling settings to it.
   */
  @MethodMetadata()
  public addCapacity(id: string, options: AddCapacityOptions): autoscaling.AutoScalingGroup {
    // Do 2-way defaulting here: if the machineImageType is BOTTLEROCKET, pick the right AMI.
    // Otherwise, determine the machineImageType from the given AMI.
    const machineImage = options.machineImage ??
      (options.machineImageType === MachineImageType.BOTTLEROCKET ? new BottleRocketImage({
        architecture: options.instanceType.architecture,
      }) : new EcsOptimizedAmi());

    const machineImageType = options.machineImageType ??
      (BottleRocketImage.isBottleRocketImage(machineImage) ? MachineImageType.BOTTLEROCKET : MachineImageType.AMAZON_LINUX_2);

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, id, {
      vpc: this.vpc,
      machineImage,
      updateType: !!options.updatePolicy ? undefined : options.updateType || autoscaling.UpdateType.REPLACING_UPDATE,
      ...options,
    });

    this.addAutoScalingGroup(autoScalingGroup, {
      machineImageType: machineImageType,
      ...options,
    });

    return autoScalingGroup;
  }

  /**
   * This method adds an Auto Scaling Group Capacity Provider to a cluster.
   *
   * @param provider the capacity provider to add to this cluster.
   */
  @MethodMetadata()
  public addAsgCapacityProvider(provider: AsgCapacityProvider, options: AddAutoScalingGroupCapacityOptions = {}) {
    // Don't add the same capacity provider more than once.
    if (this._capacityProviderNames.includes(provider.capacityProviderName)) {
      return;
    }
    this._hasEc2Capacity = true;
    this.configureAutoScalingGroup(provider.autoScalingGroup, {
      ...options,
      machineImageType: provider.machineImageType,
      // Don't enable the instance-draining lifecycle hook if managed termination protection or managed draining is enabled
      taskDrainTime: (provider.enableManagedTerminationProtection || provider.enableManagedDraining) ? Duration.seconds(0) : options.taskDrainTime,
      canContainersAccessInstanceRole: getCanContainersAccessInstanceRoleDefault(
        options.canContainersAccessInstanceRole ?? provider.canContainersAccessInstanceRole,
        FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)),
    });

    this._capacityProviderNames.push(provider.capacityProviderName);
  }

  /**
   * This method adds compute capacity to a cluster using the specified AutoScalingGroup.
   *
   * @deprecated Use `Cluster.addAsgCapacityProvider` instead.
   * @param autoScalingGroup the ASG to add to this cluster.
   * [disable-awslint:ref-via-interface] is needed in order to install the ECS
   * agent by updating the ASGs user data.
   */
  @MethodMetadata()
  public addAutoScalingGroup(autoScalingGroup: autoscaling.AutoScalingGroup, options: AddAutoScalingGroupCapacityOptions = {}) {
    this._hasEc2Capacity = true;
    this.connections.connections.addSecurityGroup(...autoScalingGroup.connections.securityGroups);
    this.configureAutoScalingGroup(autoScalingGroup, options);
  }

  private configureAutoScalingGroup(autoScalingGroup: autoscaling.AutoScalingGroup, options: AddAutoScalingGroupCapacityOptions = {}) {
    // mutating the original options may cause unexpected behavioral change, hence, creating a clone here to avoid mutation
    const optionsClone: AddAutoScalingGroupCapacityOptions = {
      ...options,
      machineImageType: options.machineImageType ?? MachineImageType.AMAZON_LINUX_2,
      canContainersAccessInstanceRole: getCanContainersAccessInstanceRoleDefault(
        options.canContainersAccessInstanceRole,
        FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)),
    };

    if (!(autoScalingGroup instanceof autoscaling.AutoScalingGroup)) {
      throw new ValidationError('Cannot configure the AutoScalingGroup because it is an imported resource.', this);
    }

    if (autoScalingGroup.osType === ec2.OperatingSystemType.WINDOWS) {
      this.configureWindowsAutoScalingGroup(autoScalingGroup, optionsClone);
    } else {
      // Tie instances to cluster
      switch (optionsClone.machineImageType) {
        // Bottlerocket AMI
        case MachineImageType.BOTTLEROCKET: {
          autoScalingGroup.addUserData(
            // Connect to the cluster
            // Source: https://github.com/bottlerocket-os/bottlerocket/blob/develop/QUICKSTART-ECS.md#connecting-to-your-cluster
            '[settings.ecs]',
            `cluster = "${this.clusterName}"`,
          );
          // Enabling SSM
          // Source: https://github.com/bottlerocket-os/bottlerocket/blob/develop/QUICKSTART-ECS.md#enabling-ssm
          autoScalingGroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
          // required managed policy
          autoScalingGroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'));

          this.handleCanContainersAccessInstanceRoleForBottleRocket(optionsClone);
          break;
        }
        case MachineImageType.AMAZON_LINUX_2: {
          autoScalingGroup.addUserData(`echo ECS_CLUSTER=${this.clusterName} >> /etc/ecs/ecs.config`);
          this.handleCanContainersAccessInstanceRoleForAL2(autoScalingGroup, optionsClone);
          if (autoScalingGroup.spotPrice && optionsClone.spotInstanceDraining) {
            autoScalingGroup.addUserData('echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config');
          }
          break;
        }
        default: {
          Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:unknownImageType',
            `Unknown ECS Image type: ${optionsClone.machineImageType}.`);
          if (optionsClone.canContainersAccessInstanceRole === false) {
            throw new ValidationError('The canContainersAccessInstanceRole option is not supported. See https://github.com/aws/aws-cdk/discussions/32609', this);
          }
          break;
        }
      }
    }

    // ECS instances must be able to do these things
    // Source: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/instance_IAM_role.html
    // But, scoped down to minimal permissions required.
    //  Notes:
    //   - 'ecs:CreateCluster' removed. The cluster already exists.
    autoScalingGroup.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecs:DeregisterContainerInstance',
        'ecs:RegisterContainerInstance',
        'ecs:Submit*',
      ],
      resources: [
        this.clusterArn,
      ],
    }));
    autoScalingGroup.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        // These act on a cluster instance, and the instance doesn't exist until the service starts.
        // Thus, scope to the cluster using a condition.
        // See: https://docs.aws.amazon.com/IAM/latest/UserGuide/list_amazonelasticcontainerservice.html
        'ecs:Poll',
        'ecs:StartTelemetrySession',
      ],
      resources: ['*'],
      conditions: {
        ArnEquals: { 'ecs:cluster': this.clusterArn },
      },
    }));
    autoScalingGroup.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        // These do not support resource constraints, and must be resource '*'
        'ecs:DiscoverPollEndpoint',
        'ecr:GetAuthorizationToken',
        // Preserved for backwards compatibility.
        // Users are able to enable cloudwatch agent using CDK. Existing
        // customers might be installing CW agent as part of user-data so if we
        // remove these permissions we will break that customer use cases.
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));

    // 0 disables, otherwise forward to underlying implementation which picks the sane default
    if (!options.taskDrainTime || options.taskDrainTime.toSeconds() !== 0) {
      new InstanceDrainHook(autoScalingGroup, 'DrainECSHook', {
        autoScalingGroup,
        cluster: this,
        drainTime: options.taskDrainTime,
        topicEncryptionKey: options.topicEncryptionKey,
      });
    }
  }

  private handleCanContainersAccessInstanceRoleForBottleRocket(options: AddAutoScalingGroupCapacityOptions): void {
    if ((options.canContainersAccessInstanceRole === false || options.canContainersAccessInstanceRole === undefined) &&
      !FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:deprecatedImdsBlocking',
        'Blocking container accessing instance role is not supported. See https://github.com/aws/aws-cdk/discussions/32609');
    }

    if (options.canContainersAccessInstanceRole === false &&
      FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)) {
      throw new ValidationError('The canContainersAccessInstanceRole option is not supported. See https://github.com/aws/aws-cdk/discussions/32609', this);
    }
  }

  private handleCanContainersAccessInstanceRoleForAL2(autoScalingGroup: autoscaling.AutoScalingGroup,
    options: AddAutoScalingGroupCapacityOptions): void {
    if (options.canContainersAccessInstanceRole === false &&
      FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)) {
      throw new ValidationError('The canContainersAccessInstanceRole option is not supported. See https://github.com/aws/aws-cdk/discussions/32609', this);
    }

    if (options.canContainersAccessInstanceRole === false ||
      options.canContainersAccessInstanceRole === undefined) {
      if (!FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking) &&
        FeatureFlags.of(this).isEnabled(Enable_IMDS_Blocking_Deprecated_Feature)) {
        // new commands from https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html#task-iam-role-considerations
        autoScalingGroup.addUserData('sudo yum install -y iptables-services; sudo iptables --insert DOCKER-USER 1 --in-interface docker+ --destination 169.254.169.254/32 --jump DROP');
        autoScalingGroup.addUserData('sudo iptables-save | sudo tee /etc/sysconfig/iptables && sudo systemctl enable --now iptables');
      } else if (!FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking) &&
        !FeatureFlags.of(this).isEnabled(Enable_IMDS_Blocking_Deprecated_Feature)) {
        // old commands
        autoScalingGroup.addUserData('sudo iptables --insert FORWARD 1 --in-interface docker+ --destination 169.254.169.254/32 --jump DROP');
        autoScalingGroup.addUserData('sudo service iptables save');

        Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:deprecatedImdsBlocking',
          'Blocking container access to instance role will be deprecated. Use the @aws-cdk/aws-ecs:enableImdsBlockingDeprecatedFeature feature flag' +
          'to keep this feature temporarily. See https://github.com/aws/aws-cdk/discussions/32609');
      }
      // The following is only for AwsVpc networking mode, but doesn't hurt for the other modes.
      autoScalingGroup.addUserData('echo ECS_AWSVPC_BLOCK_IMDS=true >> /etc/ecs/ecs.config');
    }
  }
  /**
   * This method enables the Fargate or Fargate Spot capacity providers on the cluster.
   *
   * @param provider the capacity provider to add to this cluster.
   * @deprecated Use `enableFargateCapacityProviders` instead.
   * @see `addAsgCapacityProvider` to add an Auto Scaling Group capacity provider to the cluster.
   */
  @MethodMetadata()
  public addCapacityProvider(provider: string) {
    if (!(provider === 'FARGATE' || provider === 'FARGATE_SPOT')) {
      throw new ValidationError('CapacityProvider not supported', this);
    }

    if (!this._capacityProviderNames.includes(provider)) {
      this._capacityProviderNames.push(provider);
    }
  }

  /**
   * Returns an ARN that represents all tasks within the cluster that match
   * the task pattern specified. To represent all tasks, specify ``"*"``.
   *
   * @param keyPattern Task id pattern
   */
  @MethodMetadata()
  public arnForTasks(keyPattern: string): string {
    return Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task',
      resourceName: `${this.clusterName}/${keyPattern}`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
  }

  /**
   * Grants an ECS Task Protection API permission to the specified grantee.
   * This method provides a streamlined way to assign the 'ecs:UpdateTaskProtection'
   * permission, enabling the grantee to manage task protection in the ECS cluster.
   *
   * @param grantee The entity (e.g., IAM role or user) to grant the permissions to.
   */
  @MethodMetadata()
  public grantTaskProtection(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecs:UpdateTaskProtection'],
      resourceArns: [this.arnForTasks('*')],
    });
  }

  private configureWindowsAutoScalingGroup(autoScalingGroup: autoscaling.AutoScalingGroup, options: AddAutoScalingGroupCapacityOptions = {}) {
    if ((options.canContainersAccessInstanceRole === false || options.canContainersAccessInstanceRole === undefined) &&
      !FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:deprecatedImdsBlocking',
        'Blocking container accessing instance role is not supported. See https://github.com/aws/aws-cdk/discussions/32609');
    }

    if (options.canContainersAccessInstanceRole === false &&
      FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking)) {
      throw new ValidationError('The canContainersAccessInstanceRole option is not supported. See https://github.com/aws/aws-cdk/discussions/32609', this);
    }

    // clear the cache of the agent
    autoScalingGroup.addUserData('Remove-Item -Recurse C:\\ProgramData\\Amazon\\ECS\\Cache');

    // pull the latest ECS Tools
    autoScalingGroup.addUserData('Import-Module ECSTools');

    // set the cluster name environment variable
    autoScalingGroup.addUserData(`[Environment]::SetEnvironmentVariable("ECS_CLUSTER", "${this.clusterName}", "Machine")`);
    autoScalingGroup.addUserData('[Environment]::SetEnvironmentVariable("ECS_ENABLE_AWSLOGS_EXECUTIONROLE_OVERRIDE", "true", "Machine")');
    // tslint:disable-next-line: max-line-length
    autoScalingGroup.addUserData('[Environment]::SetEnvironmentVariable("ECS_AVAILABLE_LOGGING_DRIVERS", \'["json-file","awslogs"]\', "Machine")');

    // enable instance draining
    if (autoScalingGroup.spotPrice && options.spotInstanceDraining) {
      autoScalingGroup.addUserData('[Environment]::SetEnvironmentVariable("ECS_ENABLE_SPOT_INSTANCE_DRAINING", "true", "Machine")');
    }

    // enable task iam role
    if (!options.canContainersAccessInstanceRole) {
      autoScalingGroup.addUserData('[Environment]::SetEnvironmentVariable("ECS_ENABLE_TASK_IAM_ROLE", "true", "Machine")');
      autoScalingGroup.addUserData(`Initialize-ECSAgent -Cluster '${this.clusterName}' -EnableTaskIAMRole`);
    } else {
      autoScalingGroup.addUserData(`Initialize-ECSAgent -Cluster '${this.clusterName}'`);
    }
  }

  /**
   * Getter for autoscaling group added to cluster
   */
  public get autoscalingGroup(): autoscaling.IAutoScalingGroup | undefined {
    return this._autoscalingGroup;
  }

  /**
   * Whether the cluster has EC2 capacity associated with it
   */
  public get hasEc2Capacity(): boolean {
    return this._hasEc2Capacity;
  }

  /**
   * Getter for execute command configuration associated with the cluster.
   */
  public get executeCommandConfiguration(): ExecuteCommandConfiguration | undefined {
    return this._executeCommandConfiguration;
  }

  /**
   * This method returns the CloudWatch metric for this clusters CPU reservation.
   *
   * @default average over 5 minutes
   */
  @MethodMetadata()
  public metricCpuReservation(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.cannedMetric(ECSMetrics.cpuReservationAverage, props);
  }

  /**
   * This method returns the CloudWatch metric for this clusters CPU utilization.
   *
   * @default average over 5 minutes
   */
  @MethodMetadata()
  public metricCpuUtilization(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.cannedMetric(ECSMetrics.cpuUtilizationAverage, props);
  }

  /**
   * This method returns the CloudWatch metric for this clusters memory reservation.
   *
   * @default average over 5 minutes
   */
  @MethodMetadata()
  public metricMemoryReservation(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.cannedMetric(ECSMetrics.memoryReservationAverage, props);
  }

  /**
   * This method returns the CloudWatch metric for this clusters memory utilization.
   *
   * @default average over 5 minutes
   */
  @MethodMetadata()
  public metricMemoryUtilization(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.cannedMetric(ECSMetrics.memoryUtilizationAverage, props);
  }

  /**
   * This method returns the specified CloudWatch metric for this cluster.
   */
  @MethodMetadata()
  public metric(metricName: string, props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName,
      dimensionsMap: { ClusterName: this.clusterName },
      ...props,
    }).attachTo(this);
  }

  private cannedMetric(
    fn: (dims: { ClusterName: string }) => cloudwatch.MetricProps,
    props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      ...fn({ ClusterName: this.clusterName }),
      ...props,
    }).attachTo(this);
  }
}

Object.defineProperty(Cluster.prototype, CLUSTER_SYMBOL, {
  value: true,
  enumerable: false,
  writable: false,
});

/**
 * A regional grouping of one or more container instances on which you can run tasks and services.
 */
export interface ICluster extends IResource {
  /**
   * The name of the cluster.
   * @attribute
   */
  readonly clusterName: string;

  /**
   * The Amazon Resource Name (ARN) that identifies the cluster.
   * @attribute
   */
  readonly clusterArn: string;

  /**
   * The VPC associated with the cluster.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Manage the allowed network connections for the cluster with Security Groups.
   */
  readonly connections: ec2.Connections;

  /**
   * Specifies whether the cluster has EC2 instance capacity.
   */
  readonly hasEc2Capacity: boolean;

  /**
   * The AWS Cloud Map namespace to associate with the cluster.
   */
  readonly defaultCloudMapNamespace?: cloudmap.INamespace;

  /**
   * The autoscaling group added to the cluster if capacity is associated to the cluster
   */
  readonly autoscalingGroup?: autoscaling.IAutoScalingGroup;

  /**
   * The execute command configuration for the cluster
   */
  readonly executeCommandConfiguration?: ExecuteCommandConfiguration;
}

/**
 * The properties to import from the ECS cluster.
 */
export interface ClusterAttributes {
  /**
   * The name of the cluster.
   */
  readonly clusterName: string;

  /**
   * The Amazon Resource Name (ARN) that identifies the cluster.
   *
   * @default Derived from clusterName
   */
  readonly clusterArn?: string;

  /**
   * The VPC associated with the cluster.
   */
  readonly vpc: ec2.IVpc;

  /**
   * The security groups associated with the container instances registered to the cluster.
   *
   * @default - no security groups
   */
  readonly securityGroups?: ec2.ISecurityGroup[];

  /**
   * Specifies whether the cluster has EC2 instance capacity.
   *
   * @default true
   */
  readonly hasEc2Capacity?: boolean;

  /**
   * The AWS Cloud Map namespace to associate with the cluster.
   *
   * @default - No default namespace
   */
  readonly defaultCloudMapNamespace?: cloudmap.INamespace;

  /**
   * Autoscaling group added to the cluster if capacity is added
   *
   * @default - No default autoscaling group
   */
  readonly autoscalingGroup?: autoscaling.IAutoScalingGroup;

  /**
   * The execute command configuration for the cluster
   *
   * @default - none.
   */
  readonly executeCommandConfiguration?: ExecuteCommandConfiguration;
}

/**
 * An Cluster that has been imported
 */
@propertyInjectable
class ImportedCluster extends Resource implements ICluster {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecs.ImportedCluster';
  /**
   * Name of the cluster
   */
  public readonly clusterName: string;

  /**
   * ARN of the cluster
   */
  public readonly clusterArn: string;

  /**
   * VPC that the cluster instances are running in
   */
  public readonly vpc: ec2.IVpc;

  /**
   * Security group of the cluster instances
   */
  public readonly connections = new ec2.Connections();

  /**
   * Whether the cluster has EC2 capacity
   */
  public readonly hasEc2Capacity: boolean;

  /**
   * The autoscaling group added to the cluster if capacity is associated to the cluster
   */
  public readonly autoscalingGroup?: autoscaling.IAutoScalingGroup;

  /**
   * Cloudmap namespace created in the cluster
   */
  private _defaultCloudMapNamespace?: cloudmap.INamespace;

  /**
   * The execute command configuration for the cluster
   */
  private _executeCommandConfiguration?: ExecuteCommandConfiguration;

  /**
   * Constructs a new instance of the ImportedCluster class.
   */
  constructor(scope: Construct, id: string, props: ClusterAttributes) {
    super(scope, id);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
    this.clusterName = props.clusterName;
    this.vpc = props.vpc;
    this.hasEc2Capacity = props.hasEc2Capacity !== false;
    this._defaultCloudMapNamespace = props.defaultCloudMapNamespace;
    this._executeCommandConfiguration = props.executeCommandConfiguration;
    this.autoscalingGroup = props.autoscalingGroup;

    this.clusterArn = props.clusterArn ?? Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'cluster',
      resourceName: props.clusterName,
    });

    this.connections = new ec2.Connections({
      securityGroups: props.securityGroups,
    });
  }

  public get defaultCloudMapNamespace(): cloudmap.INamespace | undefined {
    return this._defaultCloudMapNamespace;
  }

  public get executeCommandConfiguration(): ExecuteCommandConfiguration | undefined {
    return this._executeCommandConfiguration;
  }
}

/**
 * The properties for adding an AutoScalingGroup.
 */
export interface AddAutoScalingGroupCapacityOptions {
  /**
   * Specifies whether the containers can access the container instance role.
   *
   * @deprecated See https://github.com/aws/aws-cdk/discussions/32609
   * @default true if @aws-cdk/aws-ecs:disableEcsImdsBlocking feature flag is set to true.
   *   false if @aws-cdk/aws-ecs:disableEcsImdsBlocking is set to false.
   */
  readonly canContainersAccessInstanceRole?: boolean;

  /**
   * The time period to wait before force terminating an instance that is draining.
   *
   * This creates a Lambda function that is used by a lifecycle hook for the
   * AutoScalingGroup that will delay instance termination until all ECS tasks
   * have drained from the instance. Set to 0 to disable task draining.
   *
   * Set to 0 to disable task draining.
   *
   * @deprecated The lifecycle draining hook is not configured if using the EC2 Capacity Provider. Enable managed termination protection instead.
   * @default Duration.minutes(5)
   */
  readonly taskDrainTime?: Duration;

  /**
   * Specify whether to enable Automated Draining for Spot Instances running Amazon ECS Services.
   * For more information, see [Using Spot Instances](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/container-instance-spot.html).
   *
   * @default false
   */
  readonly spotInstanceDraining?: boolean;

  /**
   * If `AddAutoScalingGroupCapacityOptions.taskDrainTime` is non-zero, then the ECS cluster creates an
   * SNS Topic to as part of a system to drain instances of tasks when the instance is being shut down.
   * If this property is provided, then this key will be used to encrypt the contents of that SNS Topic.
   * See [SNS Data Encryption](https://docs.aws.amazon.com/sns/latest/dg/sns-data-encryption.html) for more information.
   *
   * @default The SNS Topic will not be encrypted.
   */
  readonly topicEncryptionKey?: kms.IKey;

  /**
   * What type of machine image this is
   *
   * Depending on the setting, different UserData will automatically be added
   * to the `AutoScalingGroup` to configure it properly for use with ECS.
   *
   * If you create an `AutoScalingGroup` yourself and are adding it via
   * `addAutoScalingGroup()`, you must specify this value. If you are adding an
   * `autoScalingGroup` via `addCapacity`, this value will be determined
   * from the `machineImage` you pass.
   *
   * @default - Automatically determined from `machineImage`, if available, otherwise `MachineImageType.AMAZON_LINUX_2`.
   */
  readonly machineImageType?: MachineImageType;
}

/**
 * The properties for adding instance capacity to an AutoScalingGroup.
 */
export interface AddCapacityOptions extends AddAutoScalingGroupCapacityOptions, autoscaling.CommonAutoScalingGroupProps {
  /**
   * The EC2 instance type to use when launching instances into the AutoScalingGroup.
   */
  readonly instanceType: ec2.InstanceType;

  /**
   * The ECS-optimized AMI variant to use
   *
   * The default is to use an ECS-optimized AMI of Amazon Linux 2 which is
   * automatically updated to the latest version on every deployment. This will
   * replace the instances in the AutoScalingGroup. Make sure you have not disabled
   * task draining, to avoid downtime when the AMI updates.
   *
   * To use an image that does not update on every deployment, pass:
   *
   * ```ts
   * const machineImage = ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.STANDARD, {
   *   cachedInContext: true,
   * });
   * ```
   *
   * For more information, see [Amazon ECS-optimized
   * AMIs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-optimized_AMI.html).
   *
   * You must define either `machineImage` or `machineImageType`, not both.
   *
   * @default - Automatically updated, ECS-optimized Amazon Linux 2
   */
  readonly machineImage?: ec2.IMachineImage;
}

/**
 * The options for creating an AWS Cloud Map namespace.
 */
export interface CloudMapNamespaceOptions {
  /**
   * The name of the namespace, such as example.com.
   */
  readonly name: string;

  /**
   * The type of CloudMap Namespace to create.
   *
   * @default PrivateDns
   */
  readonly type?: cloudmap.NamespaceType;

  /**
   * The VPC to associate the namespace with. This property is required for private DNS namespaces.
   *
   * @default VPC of the cluster for Private DNS Namespace, otherwise none
   */
  readonly vpc?: ec2.IVpc;

  /**
   * This property specifies whether to set the provided namespace as the service connect default in the cluster properties.
   *
   * @default false
   */
  readonly useForServiceConnect?: boolean;

}

/**
 * The CloudWatch Container Insights setting
 *
 * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cloudwatch-container-insights.html
 */
export enum ContainerInsights {
  /**
   * Enable CloudWatch Container Insights for the cluster
   */
  ENABLED = 'enabled',

  /**
   * Disable CloudWatch Container Insights for the cluster
   */
  DISABLED = 'disabled',

  /**
   * Enable CloudWatch Container Insights with enhanced observability for the cluster
   */
  ENHANCED = 'enhanced',
}

/**
 * A Capacity Provider strategy to use for the service.
 */
export interface CapacityProviderStrategy {
  /**
   * The name of the capacity provider.
   */
  readonly capacityProvider: string;

  /**
   * The base value designates how many tasks, at a minimum, to run on the specified capacity provider. Only one
   * capacity provider in a capacity provider strategy can have a base defined. If no value is specified, the default
   * value of 0 is used.
   *
   * @default - none
   */
  readonly base?: number;

  /**
   * The weight value designates the relative percentage of the total number of tasks launched that should use the
   * specified
   capacity provider. The weight value is taken into consideration after the base value, if defined, is satisfied.
   *
   * @default - 0
   */
  readonly weight?: number;
}

/**
 * The details of the execute command configuration. For more information, see
 * [ExecuteCommandConfiguration] https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ecs-cluster-executecommandconfiguration.html
 */
export interface ExecuteCommandConfiguration {
  /**
   * The AWS Key Management Service key ID to encrypt the data between the local client and the container.
   *
   * @default - none
   */
  readonly kmsKey?: kms.IKey;

  /**
   * The log configuration for the results of the execute command actions. The logs can be sent to CloudWatch Logs or an Amazon S3 bucket.
   *
   * @default - none
   */
  readonly logConfiguration?: ExecuteCommandLogConfiguration;

  /**
   * The log settings to use for logging the execute command session.
   *
   * @default - none
   */
  readonly logging?: ExecuteCommandLogging;
}

/**
 * The log settings to use to for logging the execute command session. For more information, see
 * [Logging] https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ecs-cluster-executecommandconfiguration.html#cfn-ecs-cluster-executecommandconfiguration-logging
 */
export enum ExecuteCommandLogging {
  /**
   * The execute command session is not logged.
   */
  NONE = 'NONE',

  /**
   * The awslogs configuration in the task definition is used. If no logging parameter is specified, it defaults to this value. If no awslogs log driver is configured in the task definition, the output won't be logged.
   */
  DEFAULT = 'DEFAULT',

  /**
   * Specify the logging details as a part of logConfiguration.
   */
  OVERRIDE = 'OVERRIDE',
}

/**
 * The log configuration for the results of the execute command actions. The logs can be sent to CloudWatch Logs and/ or an Amazon S3 bucket.
 * For more information, see [ExecuteCommandLogConfiguration] https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ecs-cluster-executecommandlogconfiguration.html
 */
export interface ExecuteCommandLogConfiguration {
  /**
   * Whether or not to enable encryption on the CloudWatch logs.
   *
   * @default - encryption will be disabled.
   */
  readonly cloudWatchEncryptionEnabled?: boolean;

  /**
   * The name of the CloudWatch log group to send logs to. The CloudWatch log group must already be created.
   * @default - none
   */
  readonly cloudWatchLogGroup?: logs.ILogGroup;

  /**
   * The name of the S3 bucket to send logs to. The S3 bucket must already be created.
   *
   * @default - none
   */
  readonly s3Bucket?: s3.IBucket;

  /**
   * Whether or not to enable encryption on the S3 bucket.
   *
   * @default - encryption will be disabled.
   */
  readonly s3EncryptionEnabled?: boolean;

  /**
   * An optional folder in the S3 bucket to place logs in.
   *
   * @default - none
   */
  readonly s3KeyPrefix?: string;
}

/**
 * The options for creating an Auto Scaling Group Capacity Provider.
 */
export interface AsgCapacityProviderProps extends AddAutoScalingGroupCapacityOptions {
  /**
   * The name of the capacity provider. If a name is specified,
   * it cannot start with `aws`, `ecs`, or `fargate`. If no name is specified,
   * a default name in the CFNStackName-CFNResourceName-RandomString format is used.
   * If the stack name starts with `aws`, `ecs`, or `fargate`, a unique resource name
   * is generated that starts with `cp-`.
   *
   * @default CloudFormation-generated name
   */
  readonly capacityProviderName?: string;

  /**
   * The autoscaling group to add as a Capacity Provider.
   *
   * Warning: When passing an imported resource using `AutoScalingGroup.fromAutoScalingGroupName` along with `enableManagedTerminationProtection: true`,
   * the `AsgCapacityProvider` construct will not be able to enforce the option `newInstancesProtectedFromScaleIn` of the `AutoScalingGroup`.
   * In this case the constructor of `AsgCapacityProvider` will throw an exception.
   */
  readonly autoScalingGroup: autoscaling.IAutoScalingGroup;

  /**
   * When enabled the scale-in and scale-out actions of the cluster's Auto Scaling Group will be managed for you.
   * This means your cluster will automatically scale instances based on the load your tasks put on the cluster.
   * For more information, see [Using Managed Scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/asg-capacity-providers.html#asg-capacity-providers-managed-scaling) in the ECS Developer Guide.
   *
   * @default true
   */
  readonly enableManagedScaling?: boolean;

  /**
   * When enabled the Auto Scaling Group will only terminate EC2 instances that no longer have running non-daemon
   * tasks.
   *
   * Scale-in protection will be automatically enabled on instances. When all non-daemon tasks are
   * stopped on an instance, ECS initiates the scale-in process and turns off scale-in protection for the
   * instance. The Auto Scaling Group can then terminate the instance. For more information see [Managed termination
   *  protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cluster-auto-scaling.html#managed-termination-protection)
   * in the ECS Developer Guide.
   *
   * Managed scaling must also be enabled.
   *
   * @default true
   */
  readonly enableManagedTerminationProtection?: boolean;

  /**
   * Managed instance draining facilitates graceful termination of Amazon ECS instances.
   * This allows your service workloads to stop safely and be rescheduled to non-terminating instances.
   * Infrastructure maintenance and updates are preformed without disruptions to workloads.
   * To use managed instance draining, set enableManagedDraining to true.
   *
   * @default true
   */
  readonly enableManagedDraining?: boolean;

  /**
   * Maximum scaling step size. In most cases this should be left alone.
   *
   * @default 1000
   */
  readonly maximumScalingStepSize?: number;

  /**
   * Minimum scaling step size. In most cases this should be left alone.
   *
   * @default 1
   */
  readonly minimumScalingStepSize?: number;

  /**
   * Target capacity percent. In most cases this should be left alone.
   *
   * @default 100
   */
  readonly targetCapacityPercent?: number;

  /**
   * The period of time, in seconds, after a newly launched Amazon EC2 instance
   * can contribute to CloudWatch metrics for Auto Scaling group.
   *
   * Must be between 0 and 10000.
   *
   * @default 300
   */
  readonly instanceWarmupPeriod?: number;
}

/**
 * Kms Keys for encryption ECS managed storage
 */
export interface ManagedStorageConfiguration {

  /**
   * Customer KMS Key used to encrypt ECS Fargate ephemeral Storage.
   * The configured KMS Key's policy will be modified to allow ECS to use the Key to encrypt the ephemeral Storage for this cluster.
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-storage-encryption.html
   *
   * @default - Encrypted using AWS-managed key
   */
  readonly fargateEphemeralStorageKmsKey?: IKey;

  /**
   * Customer KMS Key used to encrypt ECS managed Storage.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ecs-cluster-managedstorageconfiguration.html#cfn-ecs-cluster-managedstorageconfiguration-kmskeyid
   *
   * @default - Encrypted using AWS-managed key
   */
  readonly kmsKey?: IKey;
}

/**
 * An Auto Scaling Group Capacity Provider. This allows an ECS cluster to target
 * a specific EC2 Auto Scaling Group for the placement of tasks. Optionally (and
 * recommended), ECS can manage the number of instances in the ASG to fit the
 * tasks, and can ensure that instances are not prematurely terminated while
 * there are still tasks running on them.
 */
@propertyInjectable
export class AsgCapacityProvider extends Construct {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecs.AsgCapacityProvider';

  /**
   * Capacity provider name
   * @default Chosen by CloudFormation
   */
  readonly capacityProviderName: string;

  /**
   * Auto Scaling Group
   */
  readonly autoScalingGroup: autoscaling.AutoScalingGroup;

  /**
   * Auto Scaling Group machineImageType.
   */
  readonly machineImageType: MachineImageType;

  /**
   * Whether managed termination protection is enabled.
   */
  readonly enableManagedTerminationProtection?: boolean;

  /**
   * Whether managed draining is enabled.
   */
  readonly enableManagedDraining?: boolean;

  /**
   * Specifies whether the containers can access the container instance role.
   *
   * @deprecated See https://github.com/aws/aws-cdk/discussions/32609
   * @default true if @aws-cdk/aws-ecs:disableEcsImdsBlocking feature flag is set to true.
   *   false if @aws-cdk/aws-ecs:disableEcsImdsBlocking is set to false.
   */
  readonly canContainersAccessInstanceRole?: boolean;

  constructor(scope: Construct, id: string, props: AsgCapacityProviderProps) {
    super(scope, id);
    let capacityProviderName = props.capacityProviderName;
    this.autoScalingGroup = props.autoScalingGroup as autoscaling.AutoScalingGroup;
    this.machineImageType = props.machineImageType ?? MachineImageType.AMAZON_LINUX_2;
    this.canContainersAccessInstanceRole = getCanContainersAccessInstanceRoleDefault(
      props.canContainersAccessInstanceRole, FeatureFlags.of(this).isEnabled(Disable_ECS_IMDS_Blocking));
    this.enableManagedTerminationProtection = props.enableManagedTerminationProtection ?? true;
    this.enableManagedDraining = props.enableManagedDraining;

    let managedDraining = undefined;
    if (this.enableManagedDraining != undefined) {
      managedDraining = this.enableManagedDraining ? 'ENABLED' : 'DISABLED';
    }

    if (this.enableManagedTerminationProtection && props.enableManagedScaling === false) {
      throw new ValidationError('Cannot enable Managed Termination Protection on a Capacity Provider when Managed Scaling is disabled. Either enable Managed Scaling or disable Managed Termination Protection.', this);
    }
    if (this.enableManagedTerminationProtection) {
      if (this.autoScalingGroup instanceof autoscaling.AutoScalingGroup) {
        this.autoScalingGroup.protectNewInstancesFromScaleIn();
      } else {
        throw new ValidationError('Cannot enable Managed Termination Protection on a Capacity Provider when providing an imported AutoScalingGroup.', this);
      }
    }

    const capacityProviderNameRegex = /^(?!aws|ecs|fargate).+/gm;
    if (capacityProviderName) {
      if (!(capacityProviderNameRegex.test(capacityProviderName))) {
        throw new ValidationError(`Invalid Capacity Provider Name: ${capacityProviderName}, If a name is specified, it cannot start with aws, ecs, or fargate.`, this);
      }
    } else {
      if (!(capacityProviderNameRegex.test(Stack.of(this).stackName))) {
        // name cannot start with 'aws|ecs|fargate', so append 'cp-'
        // 255 is the max length, subtract 3 because of 'cp-'
        // if the regex condition isn't met, CFN will name the capacity provider
        capacityProviderName = 'cp-' + Names.uniqueResourceName(this, { maxLength: 252, allowedSpecialCharacters: '-_' });
      }
    }

    if (props.instanceWarmupPeriod && !Token.isUnresolved(props.instanceWarmupPeriod)) {
      if (props.instanceWarmupPeriod < 0 || props.instanceWarmupPeriod > 10000) {
        throw new ValidationError(`InstanceWarmupPeriod must be between 0 and 10000 inclusive, got: ${props.instanceWarmupPeriod}.`, this);
      }
    }

    const capacityProvider = new CfnCapacityProvider(this, id, {
      name: capacityProviderName,
      autoScalingGroupProvider: {
        autoScalingGroupArn: this.autoScalingGroup.autoScalingGroupName,
        managedScaling: props.enableManagedScaling === false ? undefined : {
          status: 'ENABLED',
          targetCapacity: props.targetCapacityPercent || 100,
          maximumScalingStepSize: props.maximumScalingStepSize,
          minimumScalingStepSize: props.minimumScalingStepSize,
          instanceWarmupPeriod: props.instanceWarmupPeriod,
        },
        managedTerminationProtection: this.enableManagedTerminationProtection ? 'ENABLED' : 'DISABLED',
        managedDraining: managedDraining,
      },
    });

    this.capacityProviderName = capacityProvider.ref;
  }
}

/**
 * A visitor that adds a capacity provider association to a Cluster only if
 * the caller created any EC2 Capacity Providers.
 */
class MaybeCreateCapacityProviderAssociations implements IAspect {
  private scope: Cluster;
  private id: string;
  private resource?: CfnClusterCapacityProviderAssociations;

  constructor(scope: Cluster, id: string) {
    this.scope = scope;
    this.id = id;
  }

  public visit(node: IConstruct): void {
    if (Cluster.isCluster(node)) {
      if ((this.scope.defaultCapacityProviderStrategy.length > 0 || this.scope.capacityProviderNames.length > 0 && !this.resource)) {
        this.resource = new CfnClusterCapacityProviderAssociations(this.scope, this.id, {
          cluster: node.clusterName,
          defaultCapacityProviderStrategy: this.scope.defaultCapacityProviderStrategy,
          capacityProviders: this.scope.capacityProviderNames,
        });
      }
    }
  }
}
