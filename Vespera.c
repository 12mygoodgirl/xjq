#include <stdio.h>
#include <math.h>
#define PI 3.1415926
int main()
{
    /* 某点到隧道入口长300米，到出口长400米，张角60度 */
    double a=300,b=400,angle=60,c;
    /* 余弦定理 c = sqrt(a^2 + b^2 - 2ab cosC) */
    c=sqrt(a*a+b*b-2*a*b*cos(angle*PI/180));
    printf("隧道长度为：%.2lf 米\n",c);
    return 0;
}