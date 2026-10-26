using System;

namespace Calcpad.Core
{
    public class MathParserException : Exception
    {
        internal MathParserException(string message) : base(message) { }
    }

    internal sealed class ComplexInRealModeException(string message) : MathParserException(message);
}
