#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
TEMPLATE_FILE="$REPO_DIR/deploy/aws/cloudformation.yml"

AWS_PROFILE=${AWS_PROFILE:-mochi-admin}
AWS_REGION=${AWS_REGION:-}
STACK_NAME=${STACK_NAME:-haru-bot}
INSTANCE_TYPE=${INSTANCE_TYPE:-t4g.nano}
ENV_FILE=${ENV_FILE:-$REPO_DIR/.env}
REPOSITORY_URL=${REPOSITORY_URL:-$(git -C "$REPO_DIR" remote get-url origin)}
REPOSITORY_REF=${REPOSITORY_REF:-$(git -C "$REPO_DIR" rev-parse HEAD)}
ENV_PARAMETER_NAME=${ENV_PARAMETER_NAME:-/$STACK_NAME/env-file}
MIGRATE_KV_PATH=""

usage() {
  echo "Usage: $0 [--profile PROFILE] [--region REGION] [--migrate-kv PATH]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      AWS_PROFILE=$2
      shift 2
      ;;
    --region)
      AWS_REGION=$2
      shift 2
      ;;
    --migrate-kv)
      MIGRATE_KV_PATH=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

if [ "$(wc -c < "$ENV_FILE")" -gt 4096 ]; then
  echo "Environment file exceeds the 4 KB SSM standard parameter limit." >&2
  exit 1
fi

if [ -n "$MIGRATE_KV_PATH" ] && [ ! -f "$MIGRATE_KV_PATH" ]; then
  echo "KV database does not exist: $MIGRATE_KV_PATH" >&2
  exit 1
fi

if [ -z "$AWS_REGION" ]; then
  AWS_REGION=$(aws configure get region --profile "$AWS_PROFILE")
fi
if [ -z "$AWS_REGION" ]; then
  echo "No AWS region configured. Pass --region or set AWS_REGION." >&2
  exit 1
fi

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

"${AWS[@]}" sts get-caller-identity >/dev/null

VPC_ID=${VPC_ID:-$("${AWS[@]}" ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)}
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "No default VPC found. Set VPC_ID and SUBNET_ID explicitly." >&2
  exit 1
fi

SUBNET_ID=${SUBNET_ID:-$("${AWS[@]}" ec2 describe-subnets \
  --filters Name=vpc-id,Values="$VPC_ID" Name=state,Values=available \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`]|[0].SubnetId' --output text)}
if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "None" ]; then
  echo "No public default subnet found. Set SUBNET_ID explicitly." >&2
  exit 1
fi

if [ -n "$MIGRATE_KV_PATH" ]; then
  echo "Creating a consistent snapshot of the local Deno KV database..."
  sqlite3 "$MIGRATE_KV_PATH" ".timeout 5000" ".backup '$TEMP_DIR/haru.sqlite3'"
fi

echo "Uploading Haru's encrypted runtime configuration to Parameter Store..."
"${AWS[@]}" ssm put-parameter \
  --name "$ENV_PARAMETER_NAME" \
  --description "Haru runtime environment" \
  --type SecureString \
  --tier Standard \
  --overwrite \
  --value "file://$ENV_FILE" >/dev/null

echo "Deploying the $STACK_NAME CloudFormation stack in $AWS_REGION..."
"${AWS[@]}" cloudformation deploy \
  --template-file "$TEMPLATE_FILE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    EnvironmentName=haru \
    RepositoryUrl="$REPOSITORY_URL" \
    RepositoryRef="$REPOSITORY_REF" \
    EnvParameterName="$ENV_PARAMETER_NAME" \
    InstanceType="$INSTANCE_TYPE" \
    VpcId="$VPC_ID" \
    SubnetId="$SUBNET_ID"

INSTANCE_ID=$("${AWS[@]}" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)
BACKUP_BUCKET=$("${AWS[@]}" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`BackupBucketName`].OutputValue' \
  --output text)

echo "Waiting for $INSTANCE_ID to become available through Systems Manager..."
for _ in $(seq 1 60); do
  PING_STATUS=$("${AWS[@]}" ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text)
  if [ "$PING_STATUS" = "Online" ]; then
    break
  fi
  sleep 5
done
if [ "${PING_STATUS:-}" != "Online" ]; then
  echo "Instance did not register with Systems Manager within five minutes." >&2
  exit 1
fi

run_ssm() {
  local remote_command=$1
  local parameters
  local command_id
  parameters=$(jq -cn --arg command "$remote_command" '{commands:[$command]}')
  command_id=$("${AWS[@]}" ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters "$parameters" \
    --query Command.CommandId --output text)
  if ! "${AWS[@]}" ssm wait command-executed \
    --command-id "$command_id" --instance-id "$INSTANCE_ID"; then
    "${AWS[@]}" ssm get-command-invocation \
      --command-id "$command_id" --instance-id "$INSTANCE_ID" \
      --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
      --output json >&2
    return 1
  fi
  "${AWS[@]}" ssm get-command-invocation \
    --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
    --output json
}

echo "Waiting for instance initialization..."
run_ssm "cloud-init status --wait" >/dev/null

if [ -n "$MIGRATE_KV_PATH" ]; then
  echo "Migrating Haru's local KV history..."
  "${AWS[@]}" s3 cp "$TEMP_DIR/haru.sqlite3" \
    "s3://$BACKUP_BUCKET/kv/latest.sqlite3" --only-show-errors --sse AES256
  run_ssm "sudo /usr/local/bin/haru-restore '$BACKUP_BUCKET'" >/dev/null
fi

echo "Installing and starting Haru..."
run_ssm "sudo /usr/local/bin/haru-deploy '$REPOSITORY_URL' '$REPOSITORY_REF' '$ENV_PARAMETER_NAME'" >/dev/null

echo "Verifying the service and its local health endpoint..."
run_ssm "systemctl is-active haru.service && curl -fsS --max-time 10 http://127.0.0.1:8000/health"

echo "Haru is running on $INSTANCE_ID. Backups are stored in s3://$BACKUP_BUCKET/kv/."
