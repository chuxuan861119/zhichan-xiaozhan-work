using ACadSharp.Entities;
using ACadSharp.IO.Templates;

namespace ACadSharp.IO.DWG;

internal partial class DwgObjectReader
{
    private CadTemplate readReadOnlyDetailReference()
    {
        var template = new CadInsertTemplate(new ReadOnlyDetailReference());
        // Reuse the pinned reader's base INSERT fields and handle stream. Do not
        // infer a source block from nearby geometry, filenames, or screenshots.
        this.readInsertCommonData(template);
        this.readInsertCommonHandles(template);
        this._builder.Notify("ACIDBLOCKREFERENCE displayed through its base block reference; custom editing data is not supported.", NotificationType.Warning);
        return template;
    }
}
