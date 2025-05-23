import { Construct } from 'constructs';
import { CfnResourcePolicy } from './logs.generated';
import { PolicyDocument, PolicyStatement } from '../../aws-iam';
import { Resource, Lazy, Names } from '../../core';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';

/**
 * Properties to define Cloudwatch log group resource policy
 */
export interface ResourcePolicyProps {
  /**
   * Name of the log group resource policy
   * @default - Uses a unique id based on the construct path
   */
  readonly resourcePolicyName?: string;

  /**
   * Initial statements to add to the resource policy
   *
   * @default - No statements
   */
  readonly policyStatements?: PolicyStatement[];
}

/**
 * Resource Policy for CloudWatch Log Groups
 *
 * Policies define the operations that are allowed on this resource.
 *
 * You almost never need to define this construct directly.
 *
 * All AWS resources that support resource policies have a method called
 * `addToResourcePolicy()`, which will automatically create a new resource
 * policy if one doesn't exist yet, otherwise it will add to the existing
 * policy.
 *
 * Prefer to use `addToResourcePolicy()` instead.
 */
@propertyInjectable
export class ResourcePolicy extends Resource {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-logs.ResourcePolicy';
  /**
   * The IAM policy document for this resource policy.
   */
  public readonly document = new PolicyDocument();

  constructor(scope: Construct, id: string, props?: ResourcePolicyProps) {
    super(scope, id, {
      physicalName: props?.resourcePolicyName,
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    const l1 = new CfnResourcePolicy(this, 'ResourcePolicy', {
      policyName: Lazy.string({
        produce: () => props?.resourcePolicyName ?? Names.uniqueId(this),
      }),
      policyDocument: Lazy.string({
        produce: () => JSON.stringify(this.document),
      }),
    });

    this.node.defaultChild = l1;

    if (props?.policyStatements) {
      this.document.addStatements(...props.policyStatements);
    }
  }
}
