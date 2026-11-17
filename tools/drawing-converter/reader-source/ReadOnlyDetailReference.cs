namespace ACadSharp.Entities;

/// <summary>
/// Display-only INSERT-compatible geometry from ACIDBLOCKREFERENCE.
/// Inventor editing semantics are not implemented and must not be written back to DWG.
/// </summary>
public sealed class ReadOnlyDetailReference : Insert
{
    public const string SourceType = "ACIDBLOCKREFERENCE";
}
