param(
  [Parameter(Mandatory=$true)][string]$DshBin,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$DshArgs
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $DshBin -PathType Leaf)) { throw 'DSH launcher missing' }
# Prompt is inherited on stdin, never interpolated into a command string.
if ($DshArgs -contains '--json') {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $promptText = [Console]::In.ReadToEnd()
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $promptText | & $DshBin @DshArgs
} else {
  & $DshBin @DshArgs
}
exit $LASTEXITCODE
