param(
  [Parameter(Mandatory=$true)][string]$DshBin,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$DshArgs
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $DshBin -PathType Leaf)) { throw 'DSH launcher missing' }
# Prompt is inherited on stdin, never interpolated into a command string.
& $DshBin @DshArgs
exit $LASTEXITCODE
