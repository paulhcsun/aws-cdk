import { Construct } from 'constructs';
import { CfnBackupSelection } from './backup.generated';
import { BackupableResourcesCollector } from './backupable-resources-collector';
import { IBackupPlan } from './plan';
import { BackupResource, TagOperation } from './resource';
import * as iam from '../../aws-iam';
import { Lazy, Resource, Aspects } from '../../core';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { mutatingAspectPrio32333 } from '../../core/lib/private/aspect-prio';
import { propertyInjectable } from '../../core/lib/prop-injectable';

/**
 * Options for a BackupSelection
 */
export interface BackupSelectionOptions {
  /**
   * The resources to backup.
   * Use the helper static methods defined on `BackupResource`.
   */
  readonly resources: BackupResource[];

  /**
   * The name for this selection
   *
   * @default - a CDK generated name
   */
  readonly backupSelectionName?: string;

  /**
   * The role that AWS Backup uses to authenticate when backuping or restoring
   * the resources. The `AWSBackupServiceRolePolicyForBackup` managed policy
   * will be attached to this role unless `disableDefaultBackupPolicy`
   * is set to `true`.
   *
   * @default - a new role will be created
   */
  readonly role?: iam.IRole;

  /**
   * Whether to disable automatically assigning default backup permissions to the role
   * that AWS Backup uses.
   * If `false`, the `AWSBackupServiceRolePolicyForBackup` managed policy will be
   * attached to the role.
   *
   * @default false
   */
  readonly disableDefaultBackupPolicy?: boolean;

  /**
   * Whether to automatically give restores permissions to the role that AWS
   * Backup uses. If `true`, the `AWSBackupServiceRolePolicyForRestores` managed
   * policy will be attached to the role.
   *
   * @default false
   */
  readonly allowRestores?: boolean;
}

/**
 * Properties for a BackupSelection
 */
export interface BackupSelectionProps extends BackupSelectionOptions {
  /**
   * The backup plan for this selection
   */
  readonly backupPlan: IBackupPlan;
}

/**
 * A backup selection
 */
@propertyInjectable
export class BackupSelection extends Resource implements iam.IGrantable {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-backup.BackupSelection';
  /**
   * The identifier of the backup plan.
   *
   * @attribute
   */
  public readonly backupPlanId: string;

  /**
   * The identifier of the backup selection.
   *
   * @attribute
   */
  public readonly selectionId: string;

  /**
   * The principal to grant permissions to
   */
  public readonly grantPrincipal: iam.IPrincipal;

  private listOfTags: CfnBackupSelection.ConditionResourceTypeProperty[] = [];
  private resources: string[] = [];
  private readonly backupableResourcesCollector = new BackupableResourcesCollector();

  constructor(scope: Construct, id: string, props: BackupSelectionProps) {
    super(scope, id);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    const role = props.role || new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
    });
    if (!props.disableDefaultBackupPolicy) {
      role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'));
    }
    if (props.allowRestores) {
      role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'));
    }
    this.grantPrincipal = role;

    const selection = new CfnBackupSelection(this, 'Resource', {
      backupPlanId: props.backupPlan.backupPlanId,
      backupSelection: {
        iamRoleArn: role.roleArn,
        selectionName: props.backupSelectionName || this.node.id,
        listOfTags: Lazy.any({
          produce: () => this.listOfTags,
        }, { omitEmptyArray: true }),
        resources: Lazy.list({
          produce: () => [...this.resources, ...this.backupableResourcesCollector.resources],
        }, { omitEmpty: true }),
      },
    });

    this.backupPlanId = selection.attrBackupPlanId;
    this.selectionId = selection.attrSelectionId;

    for (const resource of props.resources) {
      this.addResource(resource);
    }
  }

  private addResource(resource: BackupResource) {
    if (resource.tagCondition) {
      this.listOfTags.push({
        conditionKey: resource.tagCondition.key,
        conditionType: resource.tagCondition.operation || TagOperation.STRING_EQUALS,
        conditionValue: resource.tagCondition.value,
      });
    }

    if (resource.resource) {
      this.resources.push(resource.resource);
    }

    if (resource.construct) {
      Aspects.of(resource.construct).add(this.backupableResourcesCollector, {
        priority: mutatingAspectPrio32333(resource.construct),
      });
      // Cannot push `this.backupableResourcesCollector.resources` to
      // `this.resources` here because it has not been evaluated yet.
      // Will be concatenated to `this.resources` in a `Lazy.list`
      // in the constructor instead.
    }
  }
}
